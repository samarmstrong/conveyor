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

import { spawn, type ChildProcess } from 'node:child_process';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

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
  /** Token the agent's `git push` and `gh` use. Null = the machine's own
   *  credentials (gh login, git credential helper), which is the local case. */
  ghToken: string | null;
  log?: (msg: string) => void;
}

/** One `claude -p` invocation. */
interface Run {
  sessionId: string;
  child: ChildProcess;
  stdout: string[];
  stderr: string[];
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  startedAt: number;
}

/** One agent: a clone and every run made in it. */
interface Session {
  workspace: string;
  branch: string | null;
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
  const effort = model.params?.['effort'];
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
export function machineNote(opts: { repoUrl: string; ref: string | null; branch: string | null }): string {
  const where = `You are working in a local clone of ${opts.repoUrl}${opts.ref ? ` checked out at ${opts.ref}` : ''}.`;
  if (!opts.branch) {
    return `${where} Read and run what you need, but this session makes no changes to the repository and pushes nothing. Put your report in your final message; it is read by a program, so end with the lines it asks for.`;
  }
  return `${where} You are on branch \`${opts.branch}\`; stay on it. Commit your work there, push it to origin, and open the pull request with \`gh pr create\` — \`gh\` and \`git push\` are already authenticated. The PR must exist before you finish, and your final message must include its URL. Do not merge it.`;
}

export class ClaudeCodeWorker implements CodingWorker {
  private readonly runs = new Map<string, Run>();
  private readonly sessions = new Map<string, Session>();
  private readonly owner: string;
  private readonly repoName: string;

  constructor(private readonly opts: ClaudeCodeWorkerOptions) {
    const m = opts.repoUrl.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
    if (!m) throw new Error(`ClaudeCodeWorker: cannot read owner/repo from ${opts.repoUrl}`);
    this.owner = m[1]!;
    this.repoName = m[2]!;
    mkdirSync(opts.workRoot, { recursive: true });
    this.sweepWorkspaces();
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

  /** Verify the binary runs before any clone is made. */
  async check(): Promise<string> {
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
   *  through the credential helper set below, `git push`. */
  private childEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (this.opts.ghToken) {
      env['GH_TOKEN'] = this.opts.ghToken;
      env['GITHUB_TOKEN'] = this.opts.ghToken;
    }
    return env;
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
    await this.git(['clone', '--quiet', ...credential, this.opts.repoUrl, workspace]);
    if (this.opts.ghToken) {
      await this.git(['config', 'credential.helper', '!f() { echo username=x-access-token; echo "password=$GH_TOKEN"; }; f'], workspace);
    }
    if (this.opts.startingRef) {
      await this.git(['checkout', '--quiet', '--detach', this.opts.startingRef], workspace);
    }
    // Commits need an author; a CI runner has none configured.
    const hasIdentity = await this.git(['config', 'user.email'], workspace).catch(() => '');
    if (!hasIdentity) {
      await this.git(['config', 'user.name', 'conveyor'], workspace);
      await this.git(['config', 'user.email', 'conveyor@users.noreply.github.com'], workspace);
    }
    let branch: string | null = null;
    if (opts.autoCreatePR) {
      branch = branchNameFor(opts.name, sessionId);
      await this.git(['checkout', '--quiet', '-b', branch], workspace);
    }
    const session: Session = { workspace, branch, usage: [] };
    this.sessions.set(sessionId, session);
    return session;
  }

  private launch(sessionId: string, session: Session, prompt: string, resume: boolean): RunHandle {
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
      '--append-system-prompt', machineNote({ repoUrl: this.opts.repoUrl, ref: this.opts.startingRef, branch: session.branch }),
      ...modelArgs(this.opts.model),
    ];
    const child = spawn(this.opts.bin, args, {
      cwd: session.workspace,
      env: this.childEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const run: Run = {
      sessionId,
      child,
      stdout: [],
      stderr: [],
      startedAt: Date.now(),
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
    const sessionId = randomUUID();
    const session = await this.prepareWorkspace(sessionId, opts);
    return this.launch(sessionId, session, prompt, false);
  }

  async continueRun(handle: RunHandle, instruction: string): Promise<RunHandle> {
    const session = this.sessions.get(handle.agentId);
    if (!session) throw new Error(`ClaudeCodeWorker: no workspace for session ${handle.agentId} in this process`);
    return this.launch(handle.agentId, session, instruction, true);
  }

  async awaitResult(handle: RunHandle): Promise<RunResult> {
    const run = this.runs.get(handle.runId);
    if (!run) throw new Error(`ClaudeCodeWorker: unknown run ${handle.runId}`);
    const session = this.sessions.get(handle.agentId)!;

    const budgetMs = this.opts.maxRunMinutes * 60_000;
    let timer: NodeJS.Timeout | undefined;
    const budget = new Promise<'budget'>((res) => { timer = setTimeout(() => res('budget'), budgetMs); });
    const outcome = await Promise.race([run.exited, budget]);
    clearTimeout(timer);

    if (outcome === 'budget') {
      await this.cancel(handle);
      throw new RunBudgetExceeded(handle.runId, this.opts.maxRunMinutes);
    }

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
