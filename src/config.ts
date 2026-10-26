import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ModelSpec, WorkerKind } from './types.ts';
import { parseSeverity, type Severity } from './security.ts';

/**
 * A credential the factory holds and hands to every coding agent: the name of
 * an environment variable on the machine running the tick, and what an agent
 * should know about it. Cursor agents get it as a session-scoped env var on
 * their VM; the claude-code worker's agents inherit the tick's environment
 * anyway. The description is the whole handoff — the value is never in a
 * prompt, and an agent that knows what the variable is for can run the live
 * test that needs the real service instead of writing "no API key here".
 */
export interface AgentCredential { name: string; description: string }

export interface FactoryConfig {
  repo: { owner: string; name: string; url: string };
  worker: {
    /** Which runtime does the coding: Cursor cloud agents (`cursor`, the
     *  default) or Claude Code sessions on this machine (`claude-code`). The
     *  FACTORY_WORKER environment variable overrides it for one run, which is
     *  how a tick falls back when the Cursor account is out of usage. */
    kind: WorkerKind;
    /** Model for either worker. Written in Cursor's shape — `id` plus
     *  `params` — and translated for Claude Code (see modelArgs). */
    model: ModelSpec | null;
    /** Alternative models by name. The FACTORY_MODEL environment variable
     *  names one to run instead of `model` for one run, which is how a
     *  dispatched tick picks between them. */
    models: Record<string, ModelSpec>;
    pollIntervalSeconds: number;
    maxRunMinutes: number;
    /** claude-code only: usage, in percent of the subscription's five-hour or
     *  weekly window, at which no agent starts until that window resets.
     *  Default 90; null never waits. */
    pauseAtUsagePercent?: number | null;
    /** claude-code only: the wall-clock budget of one run. Default
     *  `maxRunMinutes` + 60. Local sessions share one machine with up to
     *  `maxConcurrentJobs` others, so the same work takes longer than on a
     *  cloud VM: on Oct 12–15 runs that landed took up to 93 minutes and
     *  twelve were cut off at 90. The groomer still sizes against
     *  `maxRunMinutes`, so an issue is no bigger for running here. */
    localMaxRunMinutes?: number;
    /** Credentials every agent is handed, by environment variable name. Only
     *  the ones actually set where the tick runs are forwarded (see
     *  agentCredentials); the rest are logged and left out. */
    agentEnv: AgentCredential[];
  };
  labels: {
    factoryPr: string;
    issueInProgress: string;
    groomed: string;
    needsWork: string;
    /** Carried by the environment agent's PRs, and by nothing else — this is
     *  what keeps them out of the `maxConcurrentJobs` count. */
    environmentPr: string;
    /** Likewise for the simplification agent's PRs. */
    simplifyPr: string;
    /** A replacement PR the review phase opened for a fork PR that needed
     *  fixes: the author's commits plus the review's. Merged in the same pass
     *  when it can be; the label keeps it out of every other queue. */
    reviewPr: string;
    /** The dependency phase's batch PR: every open Dependabot PR carried onto
     *  one branch with the lockfile regenerated. Keeps it out of every other
     *  queue, as the others do. */
    depsPr: string;
    /** The repo's own epic label. An issue carrying it is groomed as a
     *  direction — the groomer settles its open decisions and writes its
     *  children — and is never handed to the selector. Not a factory label:
     *  the repo already has one, and a human applies it. */
    epic: string;
    /** An issue that blocks the agents' own verification: a repo defect the
     *  environment pass filed from the factory's PRs, or one a human labelled
     *  so. Groomed and implemented ahead of the rest of the backlog, because
     *  every PR opened meanwhile hits it. An ordering claim only: the groomer
     *  still judges it. */
    blocker: string;
    /** The security phase's fix PRs. Keeps them out of every other queue and
     *  out of the `maxConcurrentJobs` count, as the other phases' labels do;
     *  it is also how the phase finds the alerts its PRs already claim. */
    securityPr: string;
    /** An issue still being written. The factory neither grooms nor
     *  implements it while the label is on, and holds the children of a
     *  draft epic with it. A human applies and removes it. */
    draft: string;
    /** An issue a runner is grooming right now. Put on just before the groom
     *  starts and taken off when it ends, so a second runner — the local
     *  Claude Code tick beside the Actions one — leaves it alone instead of
     *  grooming it again. The factory's own; nobody applies it by hand. */
    grooming: string;
  };
  groom: {
    maxPerTick: number;
    principlesFile: string;
    /** A name from `worker.models` to settle an epic's direction with, when
     *  that deserves a stronger model than the one that builds toward it: the
     *  first groom, and any after a human replies (see settlesDirection). The
     *  re-reviews that only track the work run `worker.model`, as does every
     *  groom when this is unset. */
    epicModel?: string;
  };
  /** How a free slot gets its issue. Off (the default), the oldest groomed
   *  issue by number is handed straight to the implementer: grooming already
   *  judged each one buildable, and a ranking agent that reads the whole
   *  groomed backlog per slot costs more as the backlog grows without changing
   *  what lands. On, a selector agent ranks the groomed issues and picks.
   *  `maxCandidates` bounds how many groomed issues one selector prompt is
   *  offered, oldest first; every open issue is fetched and groomed regardless. */
  selector: { enabled: boolean; maxCandidates: number };
  /** The environment phase: an agent that reads the factory's own PRs looking
   *  for checks the implementer could not run, and fixes the cloud-agent
   *  environment so the next one can. `maxPrsPerPass` bounds how many PRs one
   *  pass reads; only one environment PR is ever open at a time. */
  environment: { enabled: boolean; maxPrsPerPass: number };
  /** The simplification phase: an agent whose only job is to open a PR that
   *  removes more code than it adds. One such PR is open at a time. */
  simplify: { enabled: boolean };
  /** The review phase: PRs the factory did not open, reviewed against the
   *  principles, verified, fixed, and merged or closed by the factory itself.
   *  `maxPerTick` bounds how many one tick reviews. Off by default: it is the
   *  one phase that merges. A PR that conflicts with the default branch is
   *  caught up by the review agent, not handed back to its author. `model`
   *  names an entry in `worker.models` to review with, when the one judgment
   *  that merges a stranger's code deserves a stronger model than the one
   *  that builds issues; unset, reviews run `worker.model`. */
  review: { enabled: boolean; maxPerTick: number; model?: string };
  /** The dependency phase: Dependabot's open PRs carried onto one branch by one
   *  agent, the lockfile regenerated, and the batch merged on green CI under
   *  the review phase's rules. Off by default: it merges. */
  deps: { enabled: boolean };
  /** The security phase: each tick one agent takes the most severe group of
   *  the repo's open Dependabot and code scanning alerts, at or above
   *  `minSeverity`, that one PR can fix, and opens that PR — no issue, no
   *  groom. On by default: with no alerts it never starts, and it merges
   *  nothing itself. */
  security: { enabled: boolean; minSeverity: Severity };
  /**
   * Whether a phase may act on an issue a human has assigned to themselves.
   * Grooming defaults to true — vetting costs the assignee nothing and the
   * verdict is useful to them — and implementation to false, because two agents
   * on one issue is the collision the factory exists to avoid.
   */
  assignedIssues: { groom: boolean; implement: boolean };
  telemetryDir: string;
  staleRunHours: number;
  /** The throttle, in one number: how many jobs may exist at once, counting
   *  open factory PRs awaiting a human and pipelines still running. It is also
   *  the most pipelines one tick will start. 1 = strict one-at-a-time. */
  maxConcurrentJobs: number;
}

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Minimal .env loader: KEY=value lines, no expansion. Never overrides real env. */
export function loadDotEnv(root: string = projectRoot): void {
  const envPath = resolve(root, '.env');
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const key = m[1]!;
    const value = m[2]!.replace(/^["']|["']$/g, '');
    if (!(key in process.env)) process.env[key] = value;
  }
}

export function loadConfig(root: string = projectRoot): FactoryConfig {
  const path = resolve(root, 'factory.config.json');
  if (!existsSync(path)) {
    throw new Error(
      `factory.config.json not found at ${path} — copy factory.config.example.json and point it at your target repo.`,
    );
  }
  const config = JSON.parse(readFileSync(path, 'utf8')) as FactoryConfig;
  // A committed factory.config.json can predate a field the engine has since
  // grown, so a missing one is simply absent. Default to the original
  // one-job-at-a-time throttle rather than failing the next tick.
  config.maxConcurrentJobs ??= 1;
  // A local tick spends the machine's subscription, not the Cursor budget the
  // committed value is sized for, so it may run more at once.
  const maxJobs = process.env['FACTORY_MAX_JOBS']?.trim();
  if (maxJobs) {
    const n = Number(maxJobs);
    if (!Number.isInteger(n) || n < 1) throw new Error(`FACTORY_MAX_JOBS must be a positive integer, got ${JSON.stringify(maxJobs)}`);
    config.maxConcurrentJobs = n;
  }
  // An empty FACTORY_WORKER is "as configured": Actions passes the dispatch
  // input through even when nobody set it.
  config.worker.kind = workerKind(process.env['FACTORY_WORKER']?.trim() || config.worker.kind || 'cursor');
  config.worker.models ??= {};
  // Likewise an empty FACTORY_MODEL: the configured model stands.
  const modelName = process.env['FACTORY_MODEL']?.trim();
  if (modelName) {
    const model = config.worker.models[modelName];
    if (!model) {
      throw new Error(`FACTORY_MODEL=${modelName} names no model in worker.models (has: ${Object.keys(config.worker.models).join(', ') || 'none'})`);
    }
    config.worker.model = model;
  }
  config.worker.agentEnv ??= [];
  config.worker.localMaxRunMinutes ??= config.worker.maxRunMinutes + 60;
  if (config.worker.pauseAtUsagePercent === undefined) config.worker.pauseAtUsagePercent = 90;
  const pauseAt = config.worker.pauseAtUsagePercent;
  if (pauseAt !== null && !(typeof pauseAt === 'number' && pauseAt > 0 && pauseAt <= 100)) {
    throw new Error(`worker.pauseAtUsagePercent must be a percentage in (0, 100] or null, got ${JSON.stringify(pauseAt)}`);
  }
  for (const cred of config.worker.agentEnv) {
    // Cursor rejects env var names in its own namespace; the rest is shell.
    if (typeof cred?.name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(cred.name) || cred.name.startsWith('CURSOR_')) {
      throw new Error(`worker.agentEnv: not a usable environment variable name: ${JSON.stringify(cred?.name)}`);
    }
    if (typeof cred.description !== 'string' || !cred.description.trim()) {
      throw new Error(`worker.agentEnv: ${cred.name} needs a description — it is all the agent is told about the credential`);
    }
  }
  if (!Number.isInteger(config.maxConcurrentJobs) || config.maxConcurrentJobs < 1) {
    throw new Error(
      `maxConcurrentJobs must be a positive integer, got ${JSON.stringify(config.maxConcurrentJobs)}`,
    );
  }
  config.labels.environmentPr ??= 'factory:env';
  config.labels.simplifyPr ??= 'factory:simplify';
  config.labels.reviewPr ??= 'factory:review';
  config.labels.depsPr ??= 'factory:deps';
  config.labels.epic ??= 'type:epic';
  config.labels.blocker ??= 'factory:blocker';
  config.labels.securityPr ??= 'factory:security';
  config.labels.draft ??= 'factory:draft';
  config.labels.grooming ??= 'factory:grooming';
  if (config.groom.epicModel !== undefined && !config.worker.models[config.groom.epicModel]) {
    throw new Error(`groom.epicModel=${config.groom.epicModel} names no model in worker.models (has: ${Object.keys(config.worker.models).join(', ') || 'none'})`);
  }
  config.security ??= { enabled: true, minSeverity: 'high' };
  config.security.enabled ??= true;
  config.security.minSeverity = parseSeverity(config.security.minSeverity ?? 'high');
  config.simplify ??= { enabled: false };
  // The one phase that merges is the one a deployment has to ask for.
  config.review ??= { enabled: false, maxPerTick: 3 };
  config.review.enabled ??= false;
  config.deps ??= { enabled: false };
  config.deps.enabled ??= false;
  config.review.maxPerTick ??= 3;
  if (!Number.isInteger(config.review.maxPerTick) || config.review.maxPerTick < 1) {
    throw new Error(`review.maxPerTick must be a positive integer, got ${JSON.stringify(config.review.maxPerTick)}`);
  }
  if (config.review.model !== undefined && !config.worker.models[config.review.model]) {
    throw new Error(`review.model=${config.review.model} names no model in worker.models (has: ${Object.keys(config.worker.models).join(', ') || 'none'})`);
  }
  config.selector ??= { enabled: false, maxCandidates: 100 };
  config.selector.enabled ??= false;
  config.selector.maxCandidates ??= 100;
  // Narrowing what the factory touches is the safe direction for a deployment
  // that pulls this in without asking for it, so this defaults on rather than
  // preserving the old take-anything behavior.
  config.assignedIssues ??= { groom: true, implement: false };
  config.environment ??= { enabled: true, maxPrsPerPass: 3 };
  config.environment.maxPrsPerPass ??= 3;
  if (!Number.isInteger(config.environment.maxPrsPerPass) || config.environment.maxPrsPerPass < 1) {
    throw new Error(
      `environment.maxPrsPerPass must be a positive integer, got ${JSON.stringify(config.environment.maxPrsPerPass)}`,
    );
  }
  return config;
}

/** The model an epic's groom runs, when the config names one. */
export function epicGroomModel(config: FactoryConfig): ModelSpec | undefined {
  return config.groom.epicModel === undefined ? undefined : config.worker.models[config.groom.epicModel];
}

/** The model an outside PR's review runs, when the config names one. */
export function reviewModel(config: FactoryConfig): ModelSpec | undefined {
  return config.review.model === undefined ? undefined : config.worker.models[config.review.model];
}

/** The product-direction principles grooming judges against. Factory-local by
 *  design: they are about what to build, and never reach the implementer. */
export function loadPrinciples(config: FactoryConfig, root: string = projectRoot): string {
  const path = resolve(root, config.groom.principlesFile);
  if (!existsSync(path)) {
    throw new Error(`groom.principlesFile not found: ${path}`);
  }
  return readFileSync(path, 'utf8').trim();
}

export function repoSlug(config: FactoryConfig): string {
  return `${config.repo.owner}/${config.repo.name}`;
}

const WORKER_KINDS: readonly WorkerKind[] = ['cursor', 'claude-code'];

function workerKind(value: unknown): WorkerKind {
  if (typeof value === 'string' && (WORKER_KINDS as readonly string[]).includes(value)) return value as WorkerKind;
  throw new Error(`worker.kind must be one of ${WORKER_KINDS.join(', ')}, got ${JSON.stringify(value)}`);
}

/** The `claude` executable for the claude-code worker. Overridable because
 *  launchd and CI rarely have ~/.local/bin on PATH. */
export function claudeBin(): string {
  return process.env['FACTORY_CLAUDE_BIN'] ?? 'claude';
}

/** The token the claude-code worker's agents push and open PRs with, when the
 *  machine's own gh/git login is not the one to use (CI). */
export function githubTokenForAgents(): string | null {
  return process.env['GH_TOKEN'] ?? process.env['GITHUB_TOKEN'] ?? null;
}

/**
 * The configured credentials split by whether this machine actually has them.
 * An agent is told only about what is truly in its environment: a credential
 * named in config but unset here (a secret not yet added to Actions, a fresh
 * checkout without a .env) is reported once in the tick log and otherwise
 * behaves as if it were never configured.
 */
export function agentCredentials(
  config: FactoryConfig,
  env: NodeJS.ProcessEnv = process.env,
): { present: AgentCredential[]; values: Record<string, string>; missing: string[] } {
  const present: AgentCredential[] = [];
  const values: Record<string, string> = {};
  const missing: string[] = [];
  for (const cred of config.worker.agentEnv) {
    const value = env[cred.name];
    if (value) {
      present.push(cred);
      values[cred.name] = value;
    } else {
      missing.push(cred.name);
    }
  }
  return { present, values, missing };
}

export function requireCursorApiKey(): string {
  const key = process.env['CURSOR_API_KEY'];
  if (!key) {
    throw new Error(
      'CURSOR_API_KEY is not set. Create one at https://cursor.com/dashboard → API Keys, then put it in .env or the environment.',
    );
  }
  return key;
}
