// The factory controller: one idempotent tick.
//
//   reconcile with GitHub → groom ungroomed issues → simplify, alongside:
//   measure free capacity → for each free slot, take the oldest GROOMED issue,
//   blockers first (or, with the selector on, have an agent pick the
//   best-defined one) → hand
//   each to a FRESH implementer agent → label
//   the resulting PRs (or, if the attempt refuted the groom, retract the
//   verdict) → record telemetry → fix the agents' environment from what those
//   PRs said about it → yield to a human.
//
// `maxConcurrentJobs` is the whole throttle: a job is an open factory PR
// awaiting a human or a pipeline still running, at most that many exist at
// once, and so one tick starts at most that many pipelines. Default 1 keeps the
// strict one-at-a-time factory.
//
// Grooming, the environment phase, and the simplification phase all run
// outside the capacity gate on purpose: a PR sitting in review is no reason to
// stop vetting the backlog, to leave the agents' machine broken, or to let the
// code keep accreting. Environment and simplification PRs are each their own
// one-deep queue and never spend an implementer's slot. The environment phase
// runs last, after the implementers, so the PRs it reads include this tick's.
//
// Every judgment call (is this worth building, which issue, how to
// implement/verify/review it) lives in an agent; the controller only sequences
// the handoffs and keeps the capacity gate.

import { resolve } from 'node:path';
import type { CodingWorker, CurrentRun, EnvRecord, GroomRecord, RunHandle, RunRecord, RunResult, SimplifyRecord, Task, TokenUsage } from './types.ts';
import { agentCredentials, claudeBin, githubTokenForAgents, loadConfig, loadDotEnv, loadPrinciples, projectRoot, repoSlug, requireCursorApiKey, type FactoryConfig } from './config.ts';
import { RunBudgetExceeded } from './types.ts';
import { CursorWorker } from './worker.ts';
import { ClaudeCodeWorker } from './claudeCodeWorker.ts';
import { GitHubIssueSource } from './workSource.ts';
import { FactoryState } from './state.ts';
import { Telemetry } from './telemetry.ts';
import { filterAssigned, filterClaimed, filterEpics, parseSelection, type Selection } from './selector.ts';
import { environmentPrompt, fixChecksPrompt, groomEpicPrompt, groomPrompt, implementPrompt, selectPrompt, simplifyPrompt } from './prompts.ts';
import { factoryComment, groomState, isBlocker, isEpic, isGroomed, needsGroom, queueOrder, openIssues, parseGroomReply, stampExtrasFor, unaccountedBlockers, verdict, type GroomLabels, type OpenIssues } from './groom.ts';
import { addPrLabels, awaitPrChecks, closePr, commentOnIssue, commentOnPr, createIssue, defaultBranchHead, ensureLabel, findPrByBranch, listPrsByLabel, markPrReady, prChecks, viewPr } from './github.ts';
import { ENV_AGENT_MARK, environmentChangedAt, filedIssueBody, parseEnvReport, recentVerdicts, skipReason, unreadFactoryPrs, withOpenedThisTick, workerSkipReason, type UnreadPrs } from './environment.ts';
import { declinedSimplifications, recentlyMergedFactoryPrs, shrinks, skipReason as simplifySkipReason } from './simplify.ts';

export function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

interface FactoryContext {
  config: FactoryConfig;
  telemetry: Telemetry;
  state: FactoryState;
  source: GitHubIssueSource;
}

export function buildContext(): FactoryContext {
  loadDotEnv();
  const config = loadConfig();
  const telemetry = new Telemetry(resolve(projectRoot, config.telemetryDir));
  const state = new FactoryState(config, telemetry, resolve(projectRoot, config.telemetryDir));
  const source = new GitHubIssueSource(config);
  return { config, telemetry, state, source };
}

/**
 * Resolves the base once, here, so every agent a tick launches starts from the
 * same commit and none can be handed a stale clone. Which runtime the agents
 * are is `worker.kind`; nothing downstream of this function knows.
 */
export async function buildWorker(config: FactoryConfig): Promise<CodingWorker> {
  const { branch, sha } = await defaultBranchHead(repoSlug(config));
  log(`agents will start from ${branch} @ ${sha.slice(0, 8)} (worker: ${config.worker.kind})`);
  const common = {
    repoUrl: config.repo.url,
    startingRef: sha,
    model: config.worker.model,
    maxRunMinutes: config.worker.maxRunMinutes,
    log,
  };
  const credentials = agentCredentials(config);
  if (credentials.missing.length > 0) {
    log(`agent credentials not set here, so not handed to agents: ${credentials.missing.join(', ')}`);
  }
  switch (config.worker.kind) {
    case 'cursor':
      // The claude-code worker's agents inherit this process's environment, so
      // only Cursor's VMs need the values carried across.
      return new CursorWorker({ ...common, apiKey: requireCursorApiKey(), envVars: credentials.values, pollIntervalSeconds: config.worker.pollIntervalSeconds });
    case 'claude-code': {
      const worker = new ClaudeCodeWorker({
        ...common,
        bin: claudeBin(),
        workRoot: resolve(projectRoot, config.telemetryDir, 'workspaces'),
        ghToken: githubTokenForAgents(),
      });
      const version = await worker.check();
      log(`claude-code worker: ${version}; agents ${githubTokenForAgents() ? 'push with GH_TOKEN' : "push with this machine's own git/gh login"}`);
      return worker;
    }
  }
}

/**
 * Every open issue, claimed or not. Fetched once per tick: the phases filter
 * this list rather than each asking GitHub again, and the full list is what a
 * blocked verdict is checked against — an issue in progress is still open.
 */
export async function candidateTasks(ctx: FactoryContext): Promise<Task[]> {
  return ctx.source.eligibleTasks();
}

/**
 * The open set a blocked verdict is checked against. Starts as the open
 * issues; then every blocker a verdict names that is not one of them — a pull
 * request, an issue past the fetch cap — is looked up, and held open unless
 * GitHub says it is closed. Without this a verdict blocked on an open PR reads
 * as cleared every tick and is groomed again, to the same verdict, forever.
 */
export async function openSet(ctx: FactoryContext, tasks: Task[]): Promise<OpenIssues> {
  const open = openIssues(tasks);
  const unaccounted = unaccountedBlockers(tasks, open);
  if (unaccounted.length === 0) return open;
  const held = await ctx.source.stillOpen(unaccounted);
  if (held.size > 0) log(`blocker(s) not among the open issues but still open: ${[...held].map((n) => `#${n}`).join(' ')}`);
  return openIssues(tasks, held);
}

/**
 * The candidates one phase may act on. Neither touches an issue the factory
 * has claimed. They differ in whether a human's assignment excludes it, and in
 * that epics are groomed — that is where their direction gets settled — but
 * never implemented: their children are.
 */
export function admissible(ctx: FactoryContext, tasks: Task[], phase: 'groom' | 'implement'): Task[] {
  const unclaimed = filterClaimed(tasks, ctx.config.labels.issueInProgress);
  const admitted = ctx.config.assignedIssues[phase] ? unclaimed : filterAssigned(unclaimed);
  return phase === 'implement' ? filterEpics(admitted, ctx.config.labels.epic) : admitted;
}

/**
 * The grooming phase: vet up to `maxPerTick` issues against the product-direction
 * principles, in parallel. One dead groom does not sink the others — the issue
 * is simply left ungroomed and gets picked up on a later tick.
 */
export async function runGroomPhase(
  ctx: FactoryContext,
  worker: CodingWorker,
  candidates: Task[],
  opts: { limit?: number; force?: boolean; open?: OpenIssues } = {},
): Promise<GroomRecord[]> {
  const pending = needsGroom(candidates, ctx.config.labels, opts.force, opts.open).slice(0, opts.limit ?? ctx.config.groom.maxPerTick);
  if (pending.length === 0) return [];

  const principles = loadPrinciples(ctx.config);
  log(`grooming ${pending.length} issue(s): ${pending.map((t) => `#${t.issueNumber}${isEpic(t, ctx.config.labels) ? ' (epic)' : ''}`).join(' ')}`);

  const records = await Promise.all(
    pending.map((task) =>
      groomOne(ctx, worker, task, principles, opts.open).catch((err) => {
        log(`groom #${task.issueNumber} failed: ${(err as Error).message}`);
        return null;
      }),
    ),
  );
  return records.filter((r): r is GroomRecord => r !== null);
}

/** The groom prompt for this issue: direction for an epic, one PR for anything else. */
export function groomPromptFor(ctx: FactoryContext, task: Task, principles: string): string {
  return isEpic(task, ctx.config.labels)
    ? groomEpicPrompt(task, principles, ctx.config.worker)
    : groomPrompt(task, principles, ctx.config.worker, ctx.config.labels.epic);
}

async function groomOne(
  ctx: FactoryContext,
  worker: CodingWorker,
  task: Task,
  principles: string,
  open?: OpenIssues,
): Promise<GroomRecord> {
  const epic = isEpic(task, ctx.config.labels);
  const startedAt = new Date().toISOString();
  const handle = await worker.start(groomPromptFor(ctx, task, principles), {
    autoCreatePR: false,
    name: `factory-groom: #${task.issueNumber}`.slice(0, 100),
  });
  const result = await worker.awaitResult(handle);
  if (result.status !== 'FINISHED') {
    throw new Error(`groom run ended with status ${result.status}: ${result.resultText.slice(0, 300) || worker.opaqueRunNote(handle)}`);
  }
  const reply = parseGroomReply(result.resultText);
  if (!reply) {
    throw new Error(`groom reply had no VERDICT line:\n${result.resultText.slice(0, 500)}`);
  }

  // The groomer was asked "is this one PR" and answered "it is a direction".
  // Nobody has to label epics by hand for direction to get in: the factory
  // labels it, and grooms it again now — as an epic, with the epic's question —
  // rather than leaving the author to wait a tick for the verdict that matters.
  if (reply.verdict === 'epic') {
    const epicLabel = ctx.config.labels.epic;
    if (epic || epicLabel === undefined) {
      throw new Error(`groom of #${task.issueNumber} answered "epic" where that verdict was not offered`);
    }
    await ctx.source.markEpic(task, reply.reasoning);
    log(`#${task.issueNumber} is an epic, not a PR: labelled ${epicLabel}; grooming it as a direction`);
    const promoted: Task = { ...task, labels: [...task.labels, epicLabel] };
    return groomOne(ctx, worker, promoted, principles, open);
  }

  // A child's verdict names the epic record it was judged against; an epic's
  // names its children. Either way the verdict says what would make it stale.
  await ctx.source.recordGroom(task, reply, stampExtrasFor(task, ctx.config.labels, open));
  log(`groomed #${task.issueNumber}${epic ? ' (epic)' : ''} → ${reply.verdict}${reply.notes ? ' (+notes)' : ''}${reply.blocked !== undefined ? ` (blocked on #${reply.blocked})` : ''}`);

  // A groomed epic's children are the work; the verdict alone builds nothing.
  // Filed after the verdict is on record so a child always points at an epic
  // that already carries its decisions.
  let childrenFiled = 0;
  if (epic && reply.verdict === 'groomed') {
    if (reply.children.length === 0) {
      log(`epic #${task.issueNumber} groomed but the groomer wrote no children; nothing to build toward it yet.`);
    } else {
      const filed = await ctx.source.fileChildren(task, reply.children);
      childrenFiled = filed.length;
      log(`epic #${task.issueNumber}: filed ${filed.length} child issue(s): ${filed.map((c) => `#${c.number}`).join(' ')}`);
    }
  }

  const record: GroomRecord = {
    type: 'groom',
    taskId: task.id,
    issueNumber: task.issueNumber,
    issueTitle: task.title,
    verdict: reply.verdict,
    // Any prior verdict counts, whether it went stale on an edit or was
    // revisited via --force. Keying on 'stale' alone under-counts re-grooms.
    regroom: groomState(task, ctx.config.labels) !== 'ungroomed',
    hadNotes: reply.notes !== undefined,
    ...(epic ? { epic: true, childrenFiled } : {}),
    ...(reply.blocked !== undefined ? { blockedOn: reply.blocked } : {}),
    worker: ctx.config.worker.kind,
    model: ctx.config.worker.model,
    agentId: handle.agentId,
    startedAt,
    finishedAt: new Date().toISOString(),
    usage: (await worker.usage(handle.agentId)) ?? null,
    durationMs: Date.now() - Date.parse(startedAt),
  };
  ctx.telemetry.append(record);
  return record;
}

/**
 * The PR a finished run opened, if any — and no longer a draft. Every PR the
 * factory opens awaits a human, so a draft would sit unnoticed; see `markPrReady`.
 */
async function openedPr(config: FactoryConfig, result: RunResult): Promise<string | null> {
  const prUrl = result.prUrl
    ?? (result.branch ? (await findPrByBranch(repoSlug(config), result.branch))?.url : undefined)
    ?? null;
  if (prUrl) {
    await markPrReady(repoSlug(config), prUrl).catch((err: Error) => {
      log(`could not mark ${prUrl} ready for review: ${err.message}`);
    });
  }
  return prUrl;
}

/** First agent flow: the selector reads the open issues and picks one. */
export async function runSelector(
  worker: CodingWorker,
  tasks: Task[],
): Promise<{ selection: Selection; agentId: string; usage: TokenUsage | null; reply: string }> {
  const handle = await worker.start(selectPrompt(tasks), {
    autoCreatePR: false,
    name: 'factory-select',
  });
  const result = await worker.awaitResult(handle);
  if (result.status !== 'FINISHED') {
    throw new Error(`selector run ended with status ${result.status}: ${result.resultText.slice(0, 300) || worker.opaqueRunNote(handle)}`);
  }
  const usage = (await worker.usage(handle.agentId)) ?? null;
  return {
    selection: parseSelection(result.resultText, tasks),
    agentId: handle.agentId,
    usage,
    reply: result.resultText,
  };
}

/** How many of its own past verdicts the environment agent is shown. */
const ENV_VERDICTS_SHOWN = 5;

/**
 * Everything the environment phase decides on, read from GitHub in one place so
 * the tick, the dry run, and `factory status` cannot disagree. See the header
 * of environment.ts for why none of it comes from telemetry.
 */
export async function environmentInputs(config: FactoryConfig, openedThisTick: string[] = []): Promise<{
  skip: string | null;
  unread: UnreadPrs;
  changedAt: string | null;
  verdicts: string[];
}> {
  // Settled before asking GitHub anything: off, or not this worker's phase.
  const gate = config.environment.enabled ? workerSkipReason(config.worker.kind) : skipReason(false, [], { fresh: [], stale: [] });
  if (gate) {
    return { skip: gate, unread: { fresh: [], stale: [] }, changedAt: null, verdicts: [] };
  }
  const repo = repoSlug(config);
  const [envPrs, factoryPrs] = await Promise.all([
    listPrsByLabel(repo, config.labels.environmentPr, 'all'),
    listPrsByLabel(repo, config.labels.factoryPr, 'all'),
  ]);
  const openEnvPrs = envPrs.filter((p) => p.state === 'OPEN');
  const changedAt = environmentChangedAt(envPrs);
  // The PRs this tick opened are the freshest evidence and may not be in
  // GitHub's label index yet; the tick vouches for them itself.
  const unread = withOpenedThisTick(unreadFactoryPrs(factoryPrs, changedAt), openedThisTick);
  return {
    skip: skipReason(true, openEnvPrs, unread, changedAt, config.worker.kind),
    unread,
    changedAt,
    verdicts: recentVerdicts(factoryPrs, ENV_VERDICTS_SHOWN),
  };
}

/**
 * The environment phase: hand an agent the factory's own recent PRs and let it
 * decide whether any of them reports a check that could not run, then fix the
 * cloud-agent environment so the next one can.
 *
 * Nothing is parsed in either direction. The input is PR links, read by an
 * agent the way grooming reads an issue; the output is whether a branch came
 * back, the same handoff `runPipeline` already reads from an implementer.
 *
 * Returns the record it wrote, or null when the pass did not run.
 */
export async function runEnvironmentPhase(
  ctx: FactoryContext,
  worker: CodingWorker,
  openedThisTick: string[] = [],
): Promise<EnvRecord | null> {
  const { config } = ctx;
  const { skip, unread, verdicts } = await environmentInputs(config, openedThisTick);
  if (skip) {
    log(`environment: skipped — ${skip}.`);
    return null;
  }

  const prUrls = unread.fresh.slice(0, config.environment.maxPrsPerPass);
  log(`environment: reading ${prUrls.length} factory PR(s) for verification the agents could not run: ${prUrls.join(' ')}`);

  const startedAt = new Date().toISOString();
  const handle = await worker.start(environmentPrompt(prUrls, verdicts, agentCredentials(config).present), {
    autoCreatePR: true,
    name: 'factory-env',
  });

  const record = async (over: Partial<EnvRecord>): Promise<EnvRecord> => {
    const full: EnvRecord = {
      type: 'env',
      prsExamined: prUrls,
      outcome: 'no-gap',
      prUrl: null,
      worker: config.worker.kind,
      model: config.worker.model,
      agentId: handle.agentId,
      startedAt,
      finishedAt: new Date().toISOString(),
      usage: (await worker.usage(handle.agentId)) ?? null,
      durationMs: Date.now() - Date.parse(startedAt),
      ...over,
    };
    ctx.telemetry.append(full);
    return full;
  };

  const result = await worker.awaitResult(handle).catch((err: Error) => err);
  if (result instanceof Error || result.status !== 'FINISHED') {
    const reason = result instanceof Error ? result.message : `run ended with status ${result.status}`;
    log(`environment: pass failed — ${reason}`);
    // No PRs recorded as examined: a pass that never reached a conclusion must
    // not consume the reports it was given.
    return record({ outcome: 'failed', prsExamined: [], failureReason: reason });
  }

  const envPrUrl = await openedPr(config, result);

  if (envPrUrl) {
    await ensureLabel(repoSlug(config), config.labels.environmentPr, '1D76DB', 'Cloud-agent environment, opened by the software factory');
    await addPrLabels(repoSlug(config), envPrUrl, [config.labels.environmentPr]);
  }

  // A gap that was the repo's, not the machine's, is filed as an issue. It
  // carries the blocker label: an implementer hit it, so every implementer
  // after it will too, and both queues put it ahead of the backlog. The label
  // orders; the groomer still judges. Filed one at a time so a failure leaves
  // a legible partial list in the PR comment.
  const { report, issues } = parseEnvReport(result.resultText);
  const issuesFiled: string[] = [];
  if (issues.length > 0) {
    await ensureLabel(repoSlug(config), config.labels.blocker, 'B60205', 'Blocks the factory agents\' own verification; groomed and implemented ahead of the backlog');
  }
  for (const draft of issues) {
    try {
      const filed = await createIssue(repoSlug(config), draft.title, filedIssueBody(draft, prUrls), [config.labels.blocker]);
      issuesFiled.push(filed.url);
      log(`environment: filed ${filed.url} — ${draft.title}`);
    } catch (err) {
      log(`environment: could not file issue "${draft.title}": ${(err as Error).message}`);
    }
  }

  // Either way the finding belongs on the PRs that produced it — that is where
  // the human who hit the blocked check is looking.
  const alongside = prUrls.length > 1 ? ` (alongside ${prUrls.length - 1} other recent factory PR${prUrls.length > 2 ? 's' : ''})` : '';
  const filedNote = issuesFiled.length > 0
    ? `\n\nIt also read a defect in the repo itself, not the machine, and filed it ahead of the backlog as \`${config.labels.blocker}\`: ${issuesFiled.join(', ')}.`
    : '';
  // The comment is also the "read" mark the next pass looks for.
  const note = envPrUrl
    ? `🏭 ${ENV_AGENT_MARK} Reading this PR${alongside} it found a gap in the cloud-agent environment and opened ${envPrUrl} to close it.${filedNote}`
    : `🏭 ${ENV_AGENT_MARK} It read this PR${alongside} looking for a check that could not run in the cloud-agent environment, and opened none.${filedNote} Its report:\n\n${report || '_(no report)_'}`;
  for (const prUrl of prUrls) {
    await commentOnPr(repoSlug(config), prUrl, factoryComment(note)).catch((err: Error) => {
      log(`environment: could not comment on ${prUrl}: ${err.message}`);
    });
  }

  log(envPrUrl
    ? `environment: opened ${envPrUrl}; it awaits a human and does not spend an implementer slot.`
    : `environment: no gap the environment could close${issuesFiled.length ? `; ${issuesFiled.length} repo defect(s) filed as issues` : ''}.`);
  return record({ outcome: envPrUrl ? 'pr-opened' : 'no-gap', prUrl: envPrUrl, ...(issuesFiled.length ? { issuesFiled } : {}) });
}

/** Why the simplification pass is not running against `baseSha`, or null if it should. */
export async function simplifySkip(ctx: FactoryContext, baseSha: string | null): Promise<string | null> {
  const { config } = ctx;
  const openPrs = config.simplify.enabled ? await listPrsByLabel(repoSlug(config), config.labels.simplifyPr, 'open') : [];
  return simplifySkipReason(config.simplify.enabled, openPrs, ctx.telemetry.simplifyPasses(), baseSha);
}

async function simplifyPromptFor(ctx: FactoryContext): Promise<string> {
  const repo = repoSlug(ctx.config);
  const [merged, closed] = await Promise.all([
    listPrsByLabel(repo, ctx.config.labels.factoryPr, 'merged'),
    listPrsByLabel(repo, ctx.config.labels.simplifyPr, 'closed'),
  ]);
  return simplifyPrompt({
    recentPrs: recentlyMergedFactoryPrs(merged, 5),
    declinedPrs: declinedSimplifications(closed),
    budget: ctx.config.worker,
  });
}

/**
 * The simplification phase: one agent, no issue, one job — open a PR that
 * removes more code than it adds. The line count is the only thing the
 * controller judges, because it is one number GitHub already computes and the
 * failure it guards against is specific: an agent that simplifies by adding.
 * A PR that grew the code is closed here, with the numbers, before a human
 * spends a review on it.
 *
 * Returns the record it wrote, or null when the pass did not run.
 */
export async function runSimplifyPhase(ctx: FactoryContext, worker: CodingWorker): Promise<SimplifyRecord | null> {
  const { config } = ctx;
  const repo = repoSlug(config);
  const baseSha = worker.startingRef;
  const skip = await simplifySkip(ctx, baseSha);
  if (skip) {
    log(`simplify: skipped — ${skip}.`);
    return null;
  }

  log(`simplify: looking for one simplification PR at ${baseSha?.slice(0, 8) ?? 'the default branch'}`);
  const startedAt = new Date().toISOString();
  const handle = await worker.start(await simplifyPromptFor(ctx), { autoCreatePR: true, name: 'factory-simplify' });

  const record = async (over: Partial<SimplifyRecord>): Promise<SimplifyRecord> => {
    const full: SimplifyRecord = {
      type: 'simplify',
      baseSha,
      outcome: 'no-change',
      prUrl: null,
      worker: config.worker.kind,
      model: config.worker.model,
      agentId: handle.agentId,
      startedAt,
      finishedAt: new Date().toISOString(),
      usage: (await worker.usage(handle.agentId)) ?? null,
      durationMs: Date.now() - Date.parse(startedAt),
      ...over,
    };
    ctx.telemetry.append(full);
    return full;
  };

  const result = await worker.awaitResult(handle).catch((err: Error) => err);
  if (result instanceof Error || result.status !== 'FINISHED') {
    const reason = result instanceof Error ? result.message : `run ended with status ${result.status}`;
    log(`simplify: pass failed — ${reason}`);
    return record({ outcome: 'failed', failureReason: reason });
  }

  const prUrl = await openedPr(config, result);
  if (!prUrl) {
    log(`simplify: nothing proposed. Agent's report:\n${result.resultText.trim() || '_(no report)_'}`);
    return record({ outcome: 'no-change' });
  }

  const { additions, deletions } = await viewPr(repo, prUrl);
  if (!shrinks({ additions, deletions })) {
    await closePr(repo, prUrl, factoryComment(
      `🏭 **Factory simplification — closed.** A simplification PR has to remove more lines than it adds; this one adds ${additions} and removes ${deletions}. The branch is left for anyone who wants it. The next pass starts over once the code changes.`));
    log(`simplify: closed ${prUrl} — it added ${additions} and removed ${deletions} lines.`);
    return record({ outcome: 'grew', prUrl, additions, deletions });
  }

  await ensureLabel(repo, config.labels.simplifyPr, 'FBCA04', 'Simplification opened by the software factory; removes more than it adds');
  await addPrLabels(repo, prUrl, [config.labels.simplifyPr]);
  log(`simplify: opened ${prUrl} (−${deletions} +${additions}); it awaits a human and does not spend an implementer slot.`);
  return record({ outcome: 'pr-opened', prUrl, additions, deletions });
}

export async function tick(opts: { dryRun: boolean }): Promise<void> {
  const ctx = buildContext();
  const { config } = ctx;

  // 1. Record human verdicts on previously opened PRs, release their issues.
  const recorded = await ctx.state.reconcileOutcomes(log);
  if (recorded > 0) log(`reconciled ${recorded} human outcome(s)`);

  const candidates = await candidateTasks(ctx);

  if (opts.dryRun) {
    await dryRun(ctx, candidates);
    return;
  }

  const worker = await buildWorker(config);

  // 2. Grooming: vet part of the backlog. Deliberately ahead of the
  //    capacity gate — it produces no code, so it cannot collide.
  if (candidates.length > 0) {
    await runGroomPhase(ctx, worker, admissible(ctx, candidates, 'groom'), { open: await openSet(ctx, candidates) });
  }

  // 3. Simplification alongside implementation: take back some of the
  //    complexity the implementers added. Ahead of the capacity gate, its own
  //    one-deep PR queue, and deliberately independent of the backlog: an
  //    accreting codebase is a problem whether or not there is anything to
  //    build today, and the tick that notices is the idle one. Concurrent with
  //    the implementers because it touches no issue and takes no slot.
  const [, openedThisTick] = await Promise.all([
    runSimplifyPhase(ctx, worker).catch((err: Error) => {
      log(`simplify phase error: ${err.message}`);
      return null;
    }),
    runImplementation(ctx, worker, candidates),
  ]);

  // 4. Environment, last: fix the machine the implementers run on from what
  //    they said about it. It reads the factory's PRs, and the ones opened this
  //    tick are the freshest evidence — a pass before the implementers would
  //    read yesterday's and hand today's to tomorrow. Still independent of the
  //    backlog: it runs on an idle tick too, on whatever it has not yet read.
  await runEnvironmentPhase(ctx, worker, openedThisTick).catch((err: Error) => {
    log(`environment phase error: ${err.message}`);
    return null;
  });
}

interface Pick {
  task: Task;
  /** The selector agent that made the pick; undefined when the pick was oldest-first. */
  agentId?: string;
  usage: TokenUsage | null;
}

/**
 * Blockers first, then oldest first: GitHub lists newest first, and issue
 * numbers are the order issues were filed. A blocker is a defect that stops
 * implementers verifying their changes, so every PR opened while it stands
 * hits it; it goes ahead of the backlog however new it is. Same order the
 * groom queue uses, minus epics, which are never implemented.
 */
export function oldestFirst(tasks: Task[], labels: GroomLabels): Task[] {
  return [...tasks].sort(queueOrder(labels));
}

/**
 * What the selector is given: only the blockers while any stand, the whole
 * groomed set otherwise. The selector ranks by definition, not urgency, and a
 * blocker's urgency is the factory's call, not the agent's.
 */
export function selectorCandidates(tasks: Task[], labels: GroomLabels): Task[] {
  const blockers = tasks.filter((t) => isBlocker(t, labels));
  return blockers.length > 0 ? blockers : tasks;
}

/** The implementation half of a tick: capacity gate, picks, implementers. */
/** Returns the PRs it opened, for the environment pass that follows. */
async function runImplementation(ctx: FactoryContext, worker: CodingWorker, candidates: Task[]): Promise<string[]> {
  const { config } = ctx;
  if (candidates.length === 0) {
    log('no open issues. Nothing to implement.');
    return [];
  }

  // Capacity gate, for the implementation half only.
  const capacity = await ctx.state.capacity(log);
  log(`capacity: ${capacity.slots} of ${capacity.limit} slot(s) free (${capacity.openPrs.length} PR(s) awaiting a human, ${capacity.inFlight.length} pipeline(s) in flight)`);
  if (capacity.slots === 0) {
    for (const pr of capacity.openPrs) log(`  awaiting human: ${pr.url} ("${pr.title}")`);
    for (const run of capacity.inFlight) {
      log(`  in flight: ${run.taskId} (agent ${run.agentId}). Use \`factory abort\` if it is dead.`);
    }
    log('implementation paused until a human clears a slot.');
    return [];
  }

  // Picks fill the free slots. Re-fetch, since the groom phase just rewrote
  // some of the bodies we hold.
  const tasks = admissible(ctx, await candidateTasks(ctx), 'implement').filter((t) => isGroomed(t, ctx.config.labels));
  if (tasks.length === 0) {
    log('no groomed issues available to implement. Nothing to do.');
    return [];
  }

  await ensureLabel(repoSlug(config), config.labels.factoryPr, '0E8A16', 'Opened by the software factory');
  const picks = config.selector.enabled ? await pickTasks(ctx, worker, tasks, capacity.slots) : await takeOldest(ctx, tasks, capacity.slots);
  if (picks.length === 0) return [];

  // Handoff: one fresh implementer session per pick, run concurrently. They
  // work on separate branches, so the only collisions are ones a human
  // resolves at review time — the same as two people picking up two issues.
  const opened = await Promise.all(
    picks.map((pick) =>
      runPipeline(ctx, worker, pick.task, pick.agentId, pick.usage).catch(async (err) => {
        log(`pipeline error for #${pick.task.issueNumber}: ${(err as Error).message}`);
        await failRun(ctx, worker, pick.task, err as Error);
        return null;
      }),
    ),
  );
  return opened.filter((url): url is string => url !== null);
}

/**
 * The default: no agent between grooming and implementing. The oldest groomed
 * issues fill the slots, each labelled `factory:wip` as it is taken. Grooming
 * is the one judge of whether an issue is buildable, and the implementer's
 * attempt is what tests that — a ranking in between changes the order, not
 * the outcome, and its cost grows with the groomed backlog.
 */
async function takeOldest(ctx: FactoryContext, tasks: Task[], slots: number): Promise<Pick[]> {
  const picks: Pick[] = [];
  for (const task of oldestFirst(tasks, ctx.config.labels).slice(0, slots)) {
    log(`taking ${isBlocker(task, ctx.config.labels) ? 'blocker' : 'oldest groomed issue'} #${task.issueNumber} "${task.title}" (slot ${picks.length + 1} of ${slots})`);
    await ctx.source.markStarted(task);
    picks.push({ task, usage: null });
  }
  return picks;
}

/**
 * With `selector.enabled`: one selector run per free slot, each over the issues
 * the earlier runs did not take. Sequential on purpose: a pick has to see the
 * previous claims, and the issue is labelled `factory:wip` as soon as it is
 * picked.
 */
async function pickTasks(
  ctx: FactoryContext,
  worker: CodingWorker,
  tasks: Task[],
  slots: number,
): Promise<Pick[]> {
  const picks: Pick[] = [];
  let remaining = tasks;

  while (picks.length < slots && remaining.length > 0) {
    const offered = selectorCandidates(remaining, ctx.config.labels);
    log(`handing ${offered.length} groomed issue(s)${offered.length < remaining.length ? ' (blockers only)' : ''} to the selector agent (slot ${picks.length + 1} of ${slots})`);
    const picked = await runSelector(worker, offered);

    if (picked.selection.kind === 'none') {
      // The selector has no veto — size was grooming's call — so this is a
      // refusal against instruction. Logged rather than acted on: nothing here
      // should change an issue's verdict except an attempt to build it.
      log(`selector declined to pick, which it is told never to do; ending the round. Its reasoning:\n${picked.reply}`);
      break;
    }
    if (picked.selection.kind === 'unparseable') {
      // A garbled first reply is a real failure; later ones just end the round,
      // keeping the picks already claimed.
      if (picks.length === 0) {
        throw new Error(`selector reply had no usable pick:\n${picked.reply.slice(0, 500)}`);
      }
      log(`selector reply had no usable pick; keeping the ${picks.length} pick(s) already made:\n${picked.reply.slice(0, 500)}`);
      break;
    }

    const task = picked.selection.task;
    log(`selector picked #${task.issueNumber} "${task.title}"`);
    await ctx.source.markStarted(task);
    picks.push({ task, agentId: picked.agentId, usage: picked.usage });
    remaining = remaining.filter((t) => t.issueNumber !== task.issueNumber);
  }
  return picks;
}

/** What the tick would do, and the exact prompts it would send. Spends nothing. */
async function dryRun(ctx: FactoryContext, allCandidates: Task[]): Promise<void> {
  const { labels } = ctx.config;
  const candidates = admissible(ctx, allCandidates, 'groom');
  const pending = needsGroom(candidates, labels, false, await openSet(ctx, allCandidates));
  const groomed = admissible(ctx, allCandidates, 'implement').filter((t) => isGroomed(t, labels));
  const heldBack = filterClaimed(allCandidates, labels.issueInProgress).length - candidates.length;
  if (heldBack > 0) log(`${heldBack} assigned issue(s) held back from grooming.`);
  const needsWork = candidates.filter((t) => verdict(t, labels) === 'needs-work').length;
  const epics = candidates.filter((t) => isEpic(t, labels));
  const assignedGroomed = allCandidates.filter((t) => t.assignees.length > 0 && isGroomed(t, labels)).length;
  if (!ctx.config.assignedIssues.implement && assignedGroomed > 0) {
    log(`${assignedGroomed} groomed issue(s) withheld from implementation: assigned to a human.`);
  }
  // The buckets overlap: a groomed issue someone has since replied to is both
  // implementable and queued for another look.
  log(`dry run: ${candidates.length} unclaimed issue(s) — ${groomed.length} groomed and implementable, ${needsWork} needs-work, ${epics.length} epic(s) (${epics.filter((t) => isGroomed(t, labels)).length} groomed), ${pending.length} queued for a groom`);

  const next = pending.slice(0, ctx.config.groom.maxPerTick);
  if (next.length > 0) {
    log(`would groom: ${next.map((t) => `#${t.issueNumber}${isEpic(t, labels) ? ' (epic)' : isBlocker(t, labels) ? ' (blocker)' : ''}`).join(' ')}. Groom prompt for #${next[0]!.issueNumber}:`);
    console.log(`\n${groomPromptFor(ctx, next[0]!, loadPrinciples(ctx.config))}\n`);
  }
  if (groomed.length > 0 && ctx.config.selector.enabled) {
    log('selector prompt would be:');
    console.log(`\n${selectPrompt(selectorCandidates(groomed, labels))}\n`);
  } else if (groomed.length > 0) {
    log(`selector off: would implement blockers first, then oldest — ${oldestFirst(groomed, labels).slice(0, ctx.config.maxConcurrentJobs).map((t) => `#${t.issueNumber}`).join(' ')}`);
  }

  const { config } = ctx;
  const { skip, unread, verdicts } = await environmentInputs(config);
  if (skip) {
    log(`environment: would skip — ${skip}.`);
  } else {
    const prUrls = unread.fresh.slice(0, config.environment.maxPrsPerPass);
    log(`environment: would read ${prUrls.length} of ${unread.fresh.length} unread factory PR(s)${unread.stale.length ? `, ignoring ${unread.stale.length} written before the environment changed` : ''}. Its prompt would be:`);
    console.log(`\n${environmentPrompt(prUrls, verdicts, agentCredentials(ctx.config).present)}\n`);
  }

  const { sha } = await defaultBranchHead(repoSlug(config));
  const simplifySkipped = await simplifySkip(ctx, sha);
  if (simplifySkipped) {
    log(`simplify: would skip — ${simplifySkipped}.`);
    return;
  }
  log(`simplify: would look for one simplification at ${sha.slice(0, 8)}. Its prompt would be:`);
  console.log(`\n${await simplifyPromptFor(ctx)}\n`);
}

async function runPipeline(
  ctx: FactoryContext,
  worker: CodingWorker,
  task: Task,
  selectorAgentId: string | undefined,
  selectorUsage: TokenUsage | null,
): Promise<string | null> {
  const { config, state } = ctx;
  const startedAt = new Date().toISOString();

  const handle = await worker.start(implementPrompt(task, agentCredentials(config).present), {
    autoCreatePR: true,
    name: `factory: #${task.issueNumber} ${task.title}`.slice(0, 100),
  });
  const current: CurrentRun = {
    taskId: task.id,
    issueNumber: task.issueNumber,
    agentId: handle.agentId,
    runId: handle.runId,
    startedAt,
    prUrl: null,
  };
  state.writeRun(current);

  const result = await worker.awaitResult(handle);
  if (result.status !== 'FINISHED') {
    throw new Error(`run ended with status ${result.status}: ${result.resultText.slice(0, 300) || worker.opaqueRunNote(handle)}`);
  }

  const prUrl = await openedPr(config, result);
  const ci = prUrl ? await greenChecks(config, worker, handle, prUrl) : null;
  const usage = (await worker.usage(handle.agentId)) ?? null;

  if (!prUrl) {
    // The agent finished without a PR: it judged the issue not buildable as
    // scoped, or could not finish it. Either way the groom verdict is refuted
    // by the one test that counts, so it is retracted along with the report —
    // leaving the label would hand the same issue to the next selector.
    log(`no PR opened for #${task.issueNumber}; retracting the groom verdict and relaying the agent's report`);
    await ctx.source.recordFailedAttempt(task,
      `Agent's report:\n\n${result.resultText.trim() || '_(the agent gave no report)_'}`);
    await ctx.source.markFinished(task);
  } else {
    current.prUrl = prUrl;
    state.writeRun(current);
    await addPrLabels(repoSlug(config), prUrl, [config.labels.factoryPr]);
    const pause = pauseNote(config);
    const red = ci?.checks === 'red' ? ' CI is still failing on it; the implementer could not or would not make it green, and says why on the PR.' : '';
    await commentOnIssue(repoSlug(config), task.issueNumber, factoryComment(
      `🏭 The factory opened ${prUrl} for this issue. It is awaiting human review; ${pause}.${red}`));
    log(`done: ${prUrl} awaits human review (checks ${ci?.checks}); ${pause}.`);
  }

  ctx.telemetry.append({
    type: 'run',
    taskId: task.id,
    issueNumber: task.issueNumber,
    issueTitle: task.title,
    worker: config.worker.kind,
    model: config.worker.model,
    agentId: handle.agentId,
    ...(selectorAgentId === undefined ? {} : { selectorAgentId }),
    startedAt,
    finishedAt: new Date().toISOString(),
    outcome: prUrl ? 'pr-opened' : 'no-pr',
    prUrl,
    usage,
    selectorUsage,
    durationMs: Date.now() - Date.parse(startedAt),
    ...(ci ?? {}),
  });
  state.clearRun(task.id);
  return prUrl;
}

/** How long the pipeline waits for a PR's CI before treating it as unsettled. */
const CHECKS_WAIT_MS = 30 * 60_000;
/**
 * Follow-up rounds an implementer gets to turn red CI green. One: the first
 * failure is usually a suite the agent did not run, and a second round on the
 * same failure is the agent guessing. After that the human sees the red X.
 */
const FIX_ROUNDS = 1;

/**
 * A PR with a failing check should not reach a human as the factory's finished
 * work — CI is the repo's own verdict, and relaying it to the agent that just
 * wrote the code is cheaper than a reviewer reading a red X. Waits for the
 * checks, hands the failing ones back to the same agent, and waits again. The
 * follow-up run has its own `maxRunMinutes`; a blown budget or a run error
 * here leaves the PR as it stands rather than failing the pipeline, since a PR
 * exists and the groom verdict held.
 */
async function greenChecks(
  config: FactoryConfig,
  worker: CodingWorker,
  handle: RunHandle,
  prUrl: string,
): Promise<{ fixRounds: number; checks: NonNullable<RunRecord['checks']> }> {
  const repo = repoSlug(config);
  const poll = { maxWaitMs: CHECKS_WAIT_MS, pollMs: config.worker.pollIntervalSeconds * 1000, log };
  let fixRounds = 0;
  let { failed, settled } = await awaitPrChecks(repo, prUrl, poll);
  while (failed.length > 0 && fixRounds < FIX_ROUNDS) {
    fixRounds += 1;
    log(`${prUrl}: ${failed.length} failing check(s) — ${failed.map((c) => c.name).join(', ')}; handing them back to the implementer (round ${fixRounds})`);
    try {
      const followUp = await worker.continueRun(handle, fixChecksPrompt(prUrl, failed));
      const result = await worker.awaitResult(followUp);
      if (result.status !== 'FINISHED') {
        log(`${prUrl}: fix run ended with status ${result.status}; leaving the PR as it stands`);
        break;
      }
    } catch (err) {
      log(`${prUrl}: fix run failed — ${(err as Error).message}; leaving the PR as it stands`);
      break;
    }
    ({ failed, settled } = await awaitPrChecks(repo, prUrl, poll));
  }
  const checks = failed.length > 0 ? 'red' : !settled ? 'unsettled' : (await prChecks(repo, prUrl)).length === 0 ? 'none' : 'green';
  return { fixRounds, checks };
}

/** How the factory describes its own throttle, given the job cap. */
function pauseNote(config: FactoryConfig): string {
  return config.maxConcurrentJobs === 1
    ? 'the factory is paused until it is merged or closed'
    : `the factory runs up to ${config.maxConcurrentJobs} jobs at a time`;
}

async function failRun(ctx: FactoryContext, worker: CodingWorker, task: Task, err: Error): Promise<void> {
  const reason = err.message;
  const current = ctx.state.readRun(task.id);
  ctx.telemetry.append({
    type: 'run',
    taskId: task.id,
    issueNumber: task.issueNumber,
    issueTitle: task.title,
    worker: ctx.config.worker.kind,
    model: ctx.config.worker.model,
    agentId: current?.agentId ?? 'unknown',
    startedAt: current?.startedAt ?? new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    outcome: 'failed',
    failureReason: reason,
    prUrl: current?.prUrl ?? null,
    usage: current ? ((await worker.usage(current.agentId).catch(() => undefined)) ?? null) : null,
    durationMs: current ? Date.now() - Date.parse(current.startedAt) : 0,
  });
  // A run that used its whole time budget without finishing is evidence about
  // the issue, not the machinery: the groom said one PR and the attempt says
  // otherwise, so the verdict is retracted. Any other failure — Cursor errors,
  // a cancelled run, a GitHub hiccup — says nothing about the issue and only
  // releases it for a later tick.
  if (err instanceof RunBudgetExceeded && !current?.prUrl) {
    await ctx.source.recordFailedAttempt(task,
      `The implementer ran out of its ${err.maxRunMinutes}-minute budget without opening a PR.`).catch((e: Error) => {
        log(`could not retract the groom verdict on #${task.issueNumber}: ${e.message}`);
      });
  }
  // Release the issue. If a PR was created before the failure, it carries the
  // factory label and holds its slot until a human deals with it.
  await ctx.source.markFinished(task);
  ctx.state.clearRun(task.id);
}
