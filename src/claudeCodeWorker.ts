// ClaudeCodeWorker: CodingWorker implemented on local Claude Code sessions.
//
// Where CursorWorker talks to a cloud API, this one clones the target repo
// onto this machine and runs `claude -p` in it, one session per agent. It is
// the fallback for when the Cursor account is out of usage, and the option for
// running the factory on the team's Claude subscription. The controller sees
// the same four handoffs either way; the differences live here:
//
//   - The workspace is ours. Cursor cloned the repo and opened the PR itself;
//     here the worker clones at `startingRef`, puts the agent on a branch, and
//     the agent pushes and opens the PR with `gh` because the prompt says to.
//   - A run is a child process, not a remote status to poll. `awaitResult`
//     waits for exit; the budget is enforced by killing it.
//   - Follow-ups are `claude --resume <session>` in the same clone, which is
//     exactly Cursor's "same agent, same branch".
//   - Usage and cost come from the JSON result Claude Code prints. Under a
//     subscription the cost is what the run would have cost on the API — an
//     estimate for the record, not a bill.
//
// Auth is whatever the `claude` binary resolves: the machine's claude.ai login,
// or CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`) where there is no
// browser. Not `--bare`: bare mode refuses subscription credentials.
//
// The machine itself is shared by every session the worker runs, and stands in
// for the VM Cursor gives each agent: what a run starts is removed when it
// ends, and the repo's live stack is run by one agent at a time. That lives in
// localMachine.ts.
//
// A subscription is metered in a five-hour window and a weekly one, shared
// with whoever else uses the login. Every run waits for headroom before it
// starts, and a run the limit cuts off mid-turn waits for the reset and
// resumes its own session, so hitting the limit costs time, not the run.

import { spawn, type ChildProcess } from 'node:child_process';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

import {
  findDocker, forgetSession, installBin, machinePaths, recordSession, releaseSlot, resetWait, sessionEnv, sweepDeadSessions, teardown, waitedMs,
  type MachinePaths,
} from './localMachine.ts';
import {
  RunBudgetExceeded,
  type CodingWorker, type ModelSpec, type RunHandle, type RunResult, type StartOptions, type TokenUsage,
} from './types.ts';

const execFileAsync = promisify(execFile);

/** Workspaces older than this are swept when a worker is built: a follow-up
 *  run needs its clone for as long as a pipeline can live, and no longer. */
const WORKSPACE_TTL_HOURS = 24;
/** After SIGINT, how long a run gets to write its result before SIGKILL. */
const KILL_GRACE_MS = 30_000;
/** How long to wait when the usage limit is in force but its reset time is
 *  unknown, before looking again. */
const LIMIT_RECHECK_MS = 15 * 60_000;
/** Times one run may be cut off by the usage limit and resumed. */
const MAX_LIMIT_RESUMES = 3;
const LIMIT_RESUME_NOTE = 'Your previous turn was cut off by a usage limit, which has since reset. Carry on from where you stopped. Anything you had running was stopped while you waited, and the live slot was released.';
/** Runs launched together while the login's token expires race to refresh it,
 *  and the losers end at once with "Not logged in". By the time they are
 *  resumed the winner has stored the new token. */
const LOGIN_RETRY_MS = 30_000;
const MAX_LOGIN_RESUMES = 2;
const LOGIN_RESUME_NOTE = 'Your previous turn could not start because the login was being refreshed. Carry out the task above from the beginning.';
/** An implementer that ends its turn with no PR is asked once more: in -p
 *  mode the turn is the whole session, and on Oct 13 one ended "waiting for
 *  the live stack test" with a finished fix that was never pushed. */
const MAX_NO_PR_RESUMES = 1;
const NO_PR_RESUME_NOTE = 'Your turn ended without a pull request. This session ends when your turn does, so nothing you were waiting for (a background command, a test run, a server) is still going, and nobody will answer a question. If the work is done or nearly so, finish it now: verify in the foreground, commit, push, open the PR, and end with its URL. If you concluded the issue should not be built as scoped, say so again in a few lines and stop.';
/** Waits before each clone retry. On Oct 19 four grooms' clones failed in the
 *  same second (`RPC failed; curl 56`): GitHub dropped the connections, and a
 *  moment later would have served them. Each wait is jittered so clones that
 *  failed together do not retry together. */
const CLONE_RETRY_DELAYS_MS = [5_000, 15_000, 45_000];

/**
 * Runs `attempt`, and on failure waits and runs it again, once per delay. Each
 * delay is stretched by up to half again at random. The last failure is the
 * one thrown.
 */
export async function retrying<T>(
  attempt: () => Promise<T>,
  delaysMs: number[],
  onRetry: (err: unknown, delayMs: number) => void = () => {},
): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await attempt();
    } catch (err) {
      const base = delaysMs[i];
      if (base === undefined) throw err;
      const delay = base * (1 + Math.random() / 2);
      onRetry(err, delay);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

export interface ClaudeCodeWorkerOptions {
  /** The `claude` executable. launchd and CI rarely have ~/.local/bin on PATH. */
  bin: string;
  repoUrl: string;
  /** Commit every agent starts from. See CursorWorkerOptions.startingRef. */
  startingRef: string | null;
  model: ModelSpec | null;
  maxRunMinutes: number;
  /** Where clones live; one subdirectory per session. */
  workRoot: string;
  /** The live slot, the agents' bin directory, and the record of sessions in
   *  flight. Shared by every tick on this machine. Default: beside workRoot. */
  machineRoot?: string;
  /** Token the agent's `git push` and `gh` use. Null = the machine's own
   *  credentials (gh login, git credential helper), which is the local case. */
  ghToken: string | null;
  /** Usage, in percent of either subscription window, at which no run starts
   *  until that window resets. Null: never wait. */
  pauseAtUsagePercent: number | null;
  /** Reads the subscription's usage; null when it cannot be read. Injectable
   *  for tests. */
  readUsage?: () => Promise<SubscriptionUsage | null>;
  log?: (msg: string) => void;
}

/** One metering window of a Claude subscription. */
export interface UsageWindow {
  name: string;
  /** Percent of the window used. */
  utilization: number;
  /** Epoch ms; null when the API did not say. */
  resetsAt: number | null;
}

export type SubscriptionUsage = UsageWindow[];

/** One `claude -p` invocation. */
interface Run {
  sessionId: string;
  child: ChildProcess;
  stdout: string[];
  stderr: string[];
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  startedAt: number;
  /** Work time the same task already spent in runs the usage limit cut off;
   *  it counts against the budget, the wait for the reset does not, and nor
   *  does a wait for the live slot. */
  priorMs: number;
  /** How many times the usage limit has cut this task off already. */
  limitResumes: number;
  /** How many times a lost login has ended it and it was resumed. */
  loginResumes: number;
  /** How many times it ended with no PR and was asked to finish. */
  noPrResumes: number;
}

/** One agent: a clone and every run made in it. */
interface Session {
  workspace: string;
  /** The run's name, shown to an agent waiting for the slot this one holds. */
  name: string | undefined;
  branch: string | null;
  /** The existing PR whose branch this session works on, when it was started
   *  on one; its pushes update that PR rather than opening another. */
  prUrl: string | null;
  /** The model this session runs, follow-ups included. */
  model: ModelSpec | null;
  usage: TokenUsage[];
}

/** The subset of `claude -p --output-format json` this worker reads. */
export interface ClaudeResultJson {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  errors?: string[];
  session_id?: string;
  total_cost_usd?: number;
  duration_ms?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  modelUsage?: Record<string, {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
    costUSD?: number;
  }>;
}

/**
 * The factory's ModelSpec, written for Cursor's parameter shape, as Claude
 * Code flags. `context: "1m"` becomes the `[1m]` model suffix and `effort`
 * becomes `--effort`; `thinking` has no flag and
 * anything else Cursor-specific is dropped. Same config, either worker.
 */
export function modelArgs(model: ModelSpec | null): string[] {
  if (!model) return [];
  const wantsLongContext = model.params?.['context'] === '1m' && !model.id.endsWith('[1m]');
  const args = ['--model', wantsLongContext ? `${model.id}[1m]` : model.id];
  // Cursor names it `effort` for some models and `reasoning_effort` for others.
  const effort = model.params?.['effort'] ?? model.params?.['reasoning_effort'];
  if (effort) args.push('--effort', effort);
  return args;
}

/** The last JSON object on stdout, or null. Claude prints one; be tolerant of
 *  anything a hook or plugin printed before it. */
export function parseResultJson(stdout: string): ClaudeResultJson | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as ClaudeResultJson;
  } catch {
    // Fall back to the last line that looks like an object.
    const lines = trimmed.split('\n').filter((l) => l.startsWith('{'));
    for (const line of lines.reverse()) {
      try { return JSON.parse(line) as ClaudeResultJson; } catch { /* keep looking */ }
    }
    return null;
  }
}

/** Token usage from a result. `modelUsage` sums every API call the run made;
 *  the top-level `usage` is the fallback when it is absent. */
export function usageFrom(json: ClaudeResultJson): TokenUsage | null {
  const models = Object.values(json.modelUsage ?? {});
  let input = 0, output = 0, cacheRead = 0, cacheWrite = 0;
  if (models.length > 0) {
    for (const m of models) {
      input += m.inputTokens ?? 0;
      output += m.outputTokens ?? 0;
      cacheRead += m.cacheReadInputTokens ?? 0;
      cacheWrite += m.cacheCreationInputTokens ?? 0;
    }
  } else if (json.usage) {
    input = json.usage.input_tokens ?? 0;
    output = json.usage.output_tokens ?? 0;
    cacheRead = json.usage.cache_read_input_tokens ?? 0;
    cacheWrite = json.usage.cache_creation_input_tokens ?? 0;
  } else {
    return null;
  }
  const usage: TokenUsage = {
    inputTokens: input,
    outputTokens: output,
    cacheWriteTokens: cacheWrite,
    cacheReadTokens: cacheRead,
    totalTokens: input + output + cacheWrite + cacheRead,
  };
  if (json.total_cost_usd !== undefined) usage.costCents = Math.round(json.total_cost_usd * 10_000) / 100;
  return usage;
}

/** Whether a failed run's report says the subscription's usage limit ended it. */
export function hitUsageLimit(text: string): boolean {
  return /hit your (?:session |weekly |usage )?limit|usage limit reached/i.test(text);
}

/** Whether a failed run ended because Claude Code found no usable login. */
export function lostLogin(text: string): boolean {
  return /not logged in/i.test(text);
}

/**
 * How long to wait before a run may start: until every window at or over
 * `pauseAt` percent has reset. Null when none is.
 */
export function headroomWait(usage: SubscriptionUsage, pauseAt: number, now: number): { untilMs: number; full: UsageWindow[] } | null {
  const full = usage.filter((w) => w.utilization >= pauseAt);
  if (full.length === 0) return null;
  const untilMs = Math.max(...full.map((w) => (w.resetsAt !== null && w.resetsAt > now ? w.resetsAt : now + LIMIT_RECHECK_MS)));
  return { untilMs, full };
}

/** The usage API's reply as windows; anything it does not meter is skipped. */
export function parseUsage(json: unknown): SubscriptionUsage {
  const windows: SubscriptionUsage = [];
  for (const [key, name] of [['five_hour', 'five-hour'], ['seven_day', 'weekly']] as const) {
    const w = (json as Record<string, { utilization?: unknown; resets_at?: unknown } | null>)?.[key];
    if (!w || typeof w.utilization !== 'number') continue;
    const resetsAt = typeof w.resets_at === 'string' ? Date.parse(w.resets_at) : NaN;
    windows.push({ name, utilization: w.utilization, resetsAt: Number.isNaN(resetsAt) ? null : resetsAt });
  }
  return windows;
}

/** The OAuth token the machine's Claude Code login holds: macOS keychain,
 *  else ~/.claude/.credentials.json, else CLAUDE_CODE_OAUTH_TOKEN. */
async function subscriptionToken(): Promise<string | null> {
  const fromJson = (raw: string) => (JSON.parse(raw) as { claudeAiOauth?: { accessToken?: string } }).claudeAiOauth?.accessToken ?? null;
  if (process.platform === 'darwin') {
    try {
      const { stdout } = await execFileAsync('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w']);
      const token = fromJson(stdout);
      if (token) return token;
    } catch { /* not in the keychain; try the file */ }
  }
  try {
    const token = fromJson(readFileSync(resolve(homedir(), '.claude', '.credentials.json'), 'utf8'));
    if (token) return token;
  } catch { /* no credentials file */ }
  return process.env['CLAUDE_CODE_OAUTH_TOKEN'] ?? null;
}

/** The subscription's usage, from the endpoint Claude Code's own /usage reads. */
export async function readSubscriptionUsage(): Promise<SubscriptionUsage | null> {
  const token = await subscriptionToken();
  if (!token) return null;
  try {
    const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: { authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const usage = parseUsage(await res.json());
    return usage.length > 0 ? usage : null;
  } catch {
    return null;
  }
}

const sleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));

export function sumUsage(parts: TokenUsage[]): TokenUsage | undefined {
  if (parts.length === 0) return undefined;
  const total: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, totalTokens: 0 };
  let cents: number | undefined;
  for (const p of parts) {
    total.inputTokens += p.inputTokens;
    total.outputTokens += p.outputTokens;
    total.cacheWriteTokens += p.cacheWriteTokens;
    total.cacheReadTokens += p.cacheReadTokens;
    total.totalTokens += p.totalTokens;
    if (p.costCents !== undefined) cents = (cents ?? 0) + p.costCents;
  }
  if (cents !== undefined) total.costCents = Math.round(cents * 100) / 100;
  return total;
}

/** The PR the agent says it opened: the last link to one on the target repo. */
export function prUrlIn(text: string, repoUrl: string): string | undefined {
  const base = repoUrl.replace(/\.git$/, '').replace(/\/+$/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matches = text.match(new RegExp(`${base}/pull/\\d+`, 'g'));
  return matches?.at(-1);
}

/** `factory: #123 Fix the thing` → `factory/123-fix-the-thing-<8 hex>`. */
export function branchNameFor(name: string | undefined, sessionId: string): string {
  let slug = (name ?? 'agent')
    .toLowerCase()
    .replace(/^factory[:\s-]*/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  // Cut long titles at a word, not mid-word.
  if (slug.length > 40) slug = slug.slice(0, 40).replace(/-?[^-]*$/, '');
  return `factory/${slug || 'agent'}-${sessionId.slice(0, 8)}`;
}

/**
 * What the agent is told about its machine — the counterpart of the cloud
 * environment Cursor's agents got for free. Appended to the system prompt,
 * never to the factory's prompts, which stay worker-agnostic.
 */
export function machineNote(opts: { repoUrl: string; ref: string | null; branch: string | null; prUrl?: string | null }): string {
  return `${task(opts)}\n\n${SHARED_MACHINE}`;
}

/** The counterpart of an agent having a VM to itself. Said to every session:
 *  a groom may run the app to answer a question too. */
const SHARED_MACHINE = 'This machine is shared with other agents working on this repo at the same time. Before you start the repo\'s own stack or a dev server (anything that takes the container names or ports its config fixes), run `factory-slot take`; it may wait, and tells you when to run it again. While you hold the slot, the stack is yours to run as shipped, with no override files or remapped ports. Run `factory-slot release` when your live checks are done: it stops the containers and servers you started, and the next agent is waiting for it. A throwaway container or server on a name and port of your own needs no slot. When your turn ends, everything you started is removed and the slot is released, so there is nothing to clean up and nothing will be left running for later.';

function task(opts: { repoUrl: string; ref: string | null; branch: string | null; prUrl?: string | null }): string {
  // -p mode: the turn is the session. A test left running in the background
  // dies with it, and an agent that stops to wait for one loses its work.
  const foreground = 'This session ends when your turn ends: run every check in the foreground and wait for it, never stop to wait for something still running.';
  if (opts.prUrl && opts.branch) {
    return `You are working in a local clone of ${opts.repoUrl}, on branch \`${opts.branch}\`: the head of ${opts.prUrl}. Stay on it. Commit your work there and \`git push origin ${opts.branch}\`; that updates the PR. \`gh\` and \`git push\` are already authenticated. Do not open another PR, and do not merge this one. ${foreground}`;
  }
  const where = `You are working in a local clone of ${opts.repoUrl}${opts.ref ? ` checked out at ${opts.ref}` : ''}.`;
  if (!opts.branch) {
    return `${where} Read and run what you need, but this session makes no changes to the repository and pushes nothing. Put your report in your final message; it is read by a program, so end with the lines it asks for.`;
  }
  return `${where} You are on branch \`${opts.branch}\`; stay on it. Commit your work there, push it to origin, and open the pull request with \`gh pr create\` — \`gh\` and \`git push\` are already authenticated. The PR must exist before you finish, and your final message must include its URL. Do not merge it. ${foreground}`;
}

export class ClaudeCodeWorker implements CodingWorker {
  readonly runsEndWithProcess = true;
  private readonly runs = new Map<string, Run>();
  private readonly sessions = new Map<string, Session>();
  private readonly owner: string;
  private readonly repoName: string;
  /** The wait every concurrent start shares, so one wait is logged once. */
  private headroom: Promise<void> | null = null;
  private usageUnreadableLogged = false;
  private readonly machine: MachinePaths;
  private readonly docker: string | null;

  constructor(private readonly opts: ClaudeCodeWorkerOptions) {
    const m = opts.repoUrl.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
    if (!m) throw new Error(`ClaudeCodeWorker: cannot read owner/repo from ${opts.repoUrl}`);
    this.owner = m[1]!;
    this.repoName = m[2]!;
    mkdirSync(opts.workRoot, { recursive: true });
    this.sweepWorkspaces();
    this.machine = machinePaths(opts.machineRoot ?? resolve(opts.workRoot, '..', 'machine'));
    this.docker = findDocker(this.machine);
    installBin(this.machine, this.docker);
    // A tick that dies must not leave implementers running headless on the
    // machine with nobody to read their result.
    const killAll = () => { for (const run of this.runs.values()) run.child.kill('SIGTERM'); };
    process.once('exit', killAll);
    for (const sig of ['SIGINT', 'SIGTERM'] as const) {
      process.once(sig, () => { killAll(); process.exit(sig === 'SIGINT' ? 130 : 143); });
    }
  }

  get startingRef(): string | null {
    return this.opts.startingRef;
  }

  private log(msg: string): void {
    this.opts.log?.(msg);
  }

  /** Verify the binary runs before any clone is made, and clear what a tick
   *  that died left on the machine. */
  async check(): Promise<string> {
    await sweepDeadSessions(this.machine, this.docker, (msg) => this.log(msg));
    try {
      const { stdout } = await execFileAsync(this.opts.bin, ['--version']);
      return stdout.trim();
    } catch (err) {
      throw new Error(
        `Claude Code CLI not runnable as "${this.opts.bin}" (${(err as Error).message}). Install it, or point FACTORY_CLAUDE_BIN at it.`,
      );
    }
  }

  private sweepWorkspaces(): void {
    const cutoff = Date.now() - WORKSPACE_TTL_HOURS * 3_600_000;
    for (const entry of readdirSync(this.opts.workRoot)) {
      const dir = resolve(this.opts.workRoot, entry);
      try {
        if (statSync(dir).mtimeMs < cutoff) rmSync(dir, { recursive: true, force: true });
      } catch { /* a concurrent tick may have removed it */ }
    }
  }

  /** The env every git and claude process gets. GH_TOKEN reaches `gh` and,
   *  through the credential helper set below, `git push`. An agent's also
   *  marks everything it starts as its session's. */
  private childEnv(sessionId?: string): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (this.opts.ghToken) {
      env['GH_TOKEN'] = this.opts.ghToken;
      env['GITHUB_TOKEN'] = this.opts.ghToken;
    }
    const session = sessionId ? this.sessions.get(sessionId) : undefined;
    if (session) Object.assign(env, sessionEnv(this.machine, this.ref(sessionId!, session), process.env['PATH'], process.pid));
    return env;
  }

  private ref(id: string, session: Session) {
    return { id, workspace: session.workspace, ...(session.name ? { name: session.name } : {}) };
  }

  /**
   * The end of a turn: what the agent started is removed and the slot it held
   * freed, as a VM would be thrown away. Returns how long the turn waited for
   * the slot, which its budget does not count.
   */
  private async endTurn(sessionId: string): Promise<number> {
    const session = this.sessions.get(sessionId);
    if (!session) return 0;
    const waited = waitedMs(this.machine, sessionId);
    const left = await teardown(this.ref(sessionId, session), this.docker).catch(() => ({ processes: 0, containers: 0 }));
    if (releaseSlot(this.machine, sessionId)) this.log(`claude session ${sessionId} ended holding the live slot; released it`);
    if (left.processes + left.containers > 0) this.log(`removed what claude session ${sessionId} left running: ${left.processes} processes, ${left.containers} containers`);
    forgetSession(this.machine, sessionId);
    return waited;
  }

  private async git(args: string[], cwd?: string): Promise<string> {
    const { stdout } = await execFileAsync('git', args, { cwd, env: this.childEnv(), maxBuffer: 16 * 1024 * 1024 });
    return stdout.trim();
  }

  /** Clone at the pinned commit and, for a run that is expected to open a PR,
   *  put the agent on a branch of its own. */
  private async prepareWorkspace(sessionId: string, opts: StartOptions): Promise<Session> {
    const workspace = resolve(this.opts.workRoot, sessionId);
    // The helper reads GH_TOKEN from the environment at push time, so the
    // token is never written to disk.
    const credential = this.opts.ghToken
      ? ['-c', 'credential.helper=!f() { echo username=x-access-token; echo "password=$GH_TOKEN"; }; f']
      : [];
    await retrying(
      () => this.git(['clone', '--quiet', ...credential, this.opts.repoUrl, workspace]),
      CLONE_RETRY_DELAYS_MS,
      (err, delayMs) => {
        this.log(`clone for session ${sessionId} failed (${(err as Error).message.trim().split('\n').pop()}); retrying in ${Math.round(delayMs / 1000)}s`);
        rmSync(workspace, { recursive: true, force: true });
      },
    );
    if (this.opts.ghToken) {
      await this.git(['config', 'credential.helper', '!f() { echo username=x-access-token; echo "password=$GH_TOKEN"; }; f'], workspace);
    }
    // An existing PR's branch, for a handback; otherwise the pinned commit.
    const prBranch = opts.prUrl ? await this.prBranch(opts.prUrl) : null;
    if (prBranch) {
      await this.git(['checkout', '--quiet', '-B', prBranch, `origin/${prBranch}`], workspace);
    } else if (this.opts.startingRef) {
      await this.git(['checkout', '--quiet', '--detach', this.opts.startingRef], workspace);
    }
    // Commits need an author; a CI runner has none configured.
    const hasIdentity = await this.git(['config', 'user.email'], workspace).catch(() => '');
    if (!hasIdentity) {
      await this.git(['config', 'user.name', 'conveyor'], workspace);
      await this.git(['config', 'user.email', 'conveyor@users.noreply.github.com'], workspace);
    }
    let branch: string | null = prBranch;
    if (!branch && opts.autoCreatePR) {
      branch = branchNameFor(opts.name, sessionId);
      await this.git(['checkout', '--quiet', '-b', branch], workspace);
    }
    const session: Session = { workspace, name: opts.name, branch, prUrl: prBranch ? opts.prUrl! : null, model: opts.model ?? this.opts.model, usage: [] };
    this.sessions.set(sessionId, session);
    return session;
  }

  /**
   * The branch of a PR this worker may work on: one in the target repo itself.
   * A fork's branch is a stranger's code, which this worker would run on the
   * tick's own machine; reviews of those run on the cursor worker.
   */
  private async prBranch(prUrl: string): Promise<string> {
    const { stdout } = await execFileAsync('gh', ['pr', 'view', prUrl, '--json', 'headRefName,isCrossRepository'], { env: this.childEnv() });
    const pr = JSON.parse(stdout) as { headRefName: string; isCrossRepository: boolean };
    if (pr.isCrossRepository) throw new Error(`ClaudeCodeWorker works only on PRs whose branch is in ${this.repo}; ${prUrl} comes from a fork`);
    return pr.headRefName;
  }

  /** Whether a PR is open from this branch: the agent may have opened one and not said so. */
  private async branchHasPr(branch: string): Promise<boolean> {
    try {
      const { stdout } = await execFileAsync('gh', ['pr', 'list', '-R', this.repo, '--head', branch, '--state', 'open', '--json', 'url'], { env: this.childEnv() });
      return (JSON.parse(stdout) as unknown[]).length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Resolves once a run may start: at once, unless a subscription window is at
   * `pauseAtUsagePercent` or past it. `cutOff` is set after a run the limit
   * ended; then an unreadable usage is no reason to go ahead.
   */
  private awaitHeadroom(cutOff = false): Promise<void> {
    this.headroom ??= this.waitForHeadroom(cutOff).finally(() => { this.headroom = null; });
    return this.headroom;
  }

  private async waitForHeadroom(cutOff: boolean): Promise<void> {
    const pauseAt = this.opts.pauseAtUsagePercent;
    if (pauseAt === null && !cutOff) return;
    const read = this.opts.readUsage ?? readSubscriptionUsage;
    for (;;) {
      const usage = await read();
      if (!usage) {
        if (!cutOff) {
          if (!this.usageUnreadableLogged) this.log('could not read the subscription\'s usage; runs start without waiting for headroom');
          this.usageUnreadableLogged = true;
          return;
        }
        this.log(`usage limit hit and the subscription's usage cannot be read; looking again in ${LIMIT_RECHECK_MS / 60_000} min`);
        await sleep(LIMIT_RECHECK_MS);
        cutOff = false;
        continue;
      }
      const wait = headroomWait(usage, pauseAt ?? 100, Date.now());
      if (!wait) return;
      const windows = wait.full.map((w) => `${w.name} ${w.utilization}%`).join(', ');
      this.log(`subscription usage at ${windows} (pausing at ${pauseAt ?? 100}%): no run starts until ${new Date(wait.untilMs).toISOString()}`);
      // A minute past the reset, so the next read sees the new window.
      await sleep(wait.untilMs - Date.now() + 60_000);
      cutOff = false;
    }
  }

  private launch(sessionId: string, session: Session, prompt: string, resume: boolean, carried?: Pick<Run, 'priorMs' | 'limitResumes' | 'loginResumes' | 'noPrResumes'>): RunHandle {
    // The agent gets the MCP servers the target repo declares and no others:
    // not this machine's, whose owner's connectors are not the factory's to
    // hand out. The counterpart of Cursor's agents having only what the repo's
    // environment gave them.
    const repoMcp = resolve(session.workspace, '.mcp.json');
    const args = [
      '-p',
      '--output-format', 'json',
      '--dangerously-skip-permissions',
      '--strict-mcp-config', ...(existsSync(repoMcp) ? ['--mcp-config', repoMcp] : []),
      resume ? '--resume' : '--session-id', sessionId,
      '--append-system-prompt', machineNote({ repoUrl: this.opts.repoUrl, ref: this.opts.startingRef, branch: session.branch, prUrl: session.prUrl }),
      ...modelArgs(session.model),
    ];
    recordSession(this.machine, this.ref(sessionId, session), process.pid);
    resetWait(this.machine, sessionId);
    const child = spawn(this.opts.bin, args, {
      cwd: session.workspace,
      env: this.childEnv(sessionId),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const run: Run = {
      sessionId,
      child,
      stdout: [],
      stderr: [],
      startedAt: Date.now(),
      priorMs: carried?.priorMs ?? 0,
      limitResumes: carried?.limitResumes ?? 0,
      loginResumes: carried?.loginResumes ?? 0,
      noPrResumes: carried?.noPrResumes ?? 0,
      exited: new Promise((res) => {
        child.once('error', (err) => { run.stderr.push(String(err.message)); res({ code: null, signal: null }); });
        child.once('close', (code, signal) => res({ code, signal }));
      }),
    };
    child.stdout!.setEncoding('utf8').on('data', (d: string) => run.stdout.push(d));
    child.stderr!.setEncoding('utf8').on('data', (d: string) => run.stderr.push(d));
    // The prompt goes on stdin: no argv length limit, no shell quoting.
    child.stdin!.on('error', () => { /* the child died before reading; exit code says so */ });
    child.stdin!.end(prompt);

    const runId = randomUUID();
    this.runs.set(runId, run);
    this.log(`${resume ? 'follow-up on' : 'launched'} claude session ${sessionId} (pid ${child.pid ?? '?'}) in ${session.workspace}`);
    return { agentId: sessionId, runId };
  }

  async start(prompt: string, opts: StartOptions = {}): Promise<RunHandle> {
    // Only the environment boot check starts elsewhere, and that phase is Cursor's.
    if (opts.startingRef) throw new Error('ClaudeCodeWorker starts every agent from the tick\'s pinned commit');
    await this.awaitHeadroom();
    const sessionId = randomUUID();
    const session = await this.prepareWorkspace(sessionId, opts);
    return this.launch(sessionId, session, prompt, false);
  }

  async continueRun(handle: RunHandle, instruction: string): Promise<RunHandle> {
    const session = this.sessions.get(handle.agentId);
    if (!session) throw new Error(`ClaudeCodeWorker: no workspace for session ${handle.agentId} in this process`);
    await this.awaitHeadroom();
    return this.launch(handle.agentId, session, instruction, true);
  }

  async awaitResult(handle: RunHandle): Promise<RunResult> {
    const run = this.runs.get(handle.runId);
    if (!run) throw new Error(`ClaudeCodeWorker: unknown run ${handle.runId}`);
    const session = this.sessions.get(handle.agentId)!;

    // The budget runs out at the deadline, moved on by however long the run
    // has waited for the live slot by then.
    let deadline = run.startedAt + this.opts.maxRunMinutes * 60_000 - run.priorMs;
    let credited = 0;
    let outcome: Awaited<Run['exited']> | 'budget';
    for (;;) {
      let timer: NodeJS.Timeout | undefined;
      const budget = new Promise<'budget'>((res) => { timer = setTimeout(() => res('budget'), Math.max(0, deadline - Date.now())); });
      outcome = await Promise.race([run.exited, budget]);
      clearTimeout(timer);
      if (outcome !== 'budget') break;
      const waited = waitedMs(this.machine, handle.agentId);
      if (waited <= credited) break;
      deadline += waited - credited;
      credited = waited;
    }

    if (outcome === 'budget') {
      await this.cancel(handle);
      throw new RunBudgetExceeded(handle.runId, this.opts.maxRunMinutes);
    }
    const workedMs = Date.now() - run.startedAt - (await this.endTurn(handle.agentId));

    const stdout = run.stdout.join('');
    const stderr = run.stderr.join('');
    const json = parseResultJson(stdout);
    const usage = json ? usageFrom(json) : null;
    if (usage) session.usage.push(usage);

    const succeeded = outcome.code === 0 && json !== null && json.is_error !== true && (json.subtype ?? 'success') === 'success';
    const tail = (s: string) => s.trim().split('\n').slice(-20).join('\n');
    const reported = json?.result ?? (json?.errors?.length ? json.errors.join('\n') : '');
    const resultText = reported || (succeeded ? '' : tail(stderr) || tail(stdout));
    if (!succeeded) {
      this.log(`claude session ${handle.agentId} ended: exit ${outcome.code ?? `signal ${outcome.signal}`}${json?.subtype ? `, ${json.subtype}` : ''}`);
    }
    if (!succeeded && !outcome.signal && hitUsageLimit(resultText) && run.limitResumes < MAX_LIMIT_RESUMES) {
      this.log(`claude session ${handle.agentId} was cut off by the usage limit; resuming it once the limit resets`);
      const carried = { priorMs: run.priorMs + workedMs, limitResumes: run.limitResumes + 1, loginResumes: run.loginResumes, noPrResumes: run.noPrResumes };
      await this.awaitHeadroom(true);
      const next = this.launch(handle.agentId, session, LIMIT_RESUME_NOTE, true, carried);
      return this.awaitResult(next);
    }
    if (!succeeded && !outcome.signal && lostLogin(resultText) && run.loginResumes < MAX_LOGIN_RESUMES) {
      this.log(`claude session ${handle.agentId} found no login (a token refresh race); resuming it in ${LOGIN_RETRY_MS / 1000}s`);
      const carried = { priorMs: run.priorMs + workedMs, limitResumes: run.limitResumes, loginResumes: run.loginResumes + 1, noPrResumes: run.noPrResumes };
      await sleep(LOGIN_RETRY_MS);
      const next = this.launch(handle.agentId, session, LOGIN_RESUME_NOTE, true, carried);
      return this.awaitResult(next);
    }

    const expectsPr = session.branch !== null && session.prUrl === null;
    if (succeeded && expectsPr && !prUrlIn(resultText, this.opts.repoUrl) && run.noPrResumes < MAX_NO_PR_RESUMES && !(await this.branchHasPr(session.branch!))) {
      this.log(`claude session ${handle.agentId} ended its turn with no PR; asking it once to finish`);
      const carried = { priorMs: run.priorMs + workedMs, limitResumes: run.limitResumes, loginResumes: run.loginResumes, noPrResumes: run.noPrResumes + 1 };
      const next = this.launch(handle.agentId, session, NO_PR_RESUME_NOTE, true, carried);
      return this.awaitResult(next);
    }

    // The branch the agent left HEAD on, if it is a branch at all: a
    // read-only session stays detached at the pinned commit.
    let branch: string | undefined;
    if (session.branch) {
      const head = await this.git(['rev-parse', '--abbrev-ref', 'HEAD'], session.workspace).catch(() => 'HEAD');
      branch = head === 'HEAD' ? session.branch : head;
    }

    return {
      status: succeeded ? 'FINISHED' : outcome.signal ? 'CANCELLED' : 'ERROR',
      resultText,
      branch,
      prUrl: prUrlIn(resultText, this.opts.repoUrl),
      durationMs: json?.duration_ms ?? Date.now() - run.startedAt,
    };
  }

  async usage(agentId: string): Promise<TokenUsage | undefined> {
    return sumUsage(this.sessions.get(agentId)?.usage ?? []);
  }

  async cancel(handle: RunHandle): Promise<void> {
    const run = this.runs.get(handle.runId);
    if (!run) {
      this.log(`run ${handle.runId} is not in this process; a local run dies with the tick that started it`);
      return;
    }
    if (run.child.exitCode !== null || run.child.signalCode !== null) return;
    // SIGINT ends the turn and lets Claude write its result; SIGKILL if it does not.
    run.child.kill('SIGINT');
    const grace = new Promise<void>((res) => setTimeout(res, KILL_GRACE_MS));
    await Promise.race([run.exited.then(() => undefined), grace]);
    if (run.child.exitCode === null && run.child.signalCode === null) run.child.kill('SIGKILL');
    await this.endTurn(handle.agentId);
  }

  opaqueRunNote(handle: RunHandle): string {
    const ws = this.sessions.get(handle.agentId)?.workspace ?? '<workspace gone>';
    return `Claude Code printed no result; read the transcript with \`claude --resume ${handle.agentId}\` from ${ws}`;
  }

  /** For logs and tests. */
  get repo(): string {
    return `${this.owner}/${this.repoName}`;
  }
}
