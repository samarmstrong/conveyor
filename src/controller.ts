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
// Grooming, the environment phase, the simplification phase, the review of
// PRs the factory did not open, the Dependabot batch, and the security fix
// all run outside the capacity gate on purpose: a PR sitting in review is no
// reason to stop vetting the backlog, to leave the agents' machine broken, to
// let the code keep accreting, or to leave someone else's PR — or a week of
// bumps, or an open alert — waiting.
// Environment, simplification, dependency, and security PRs are each their own
// queue and never spend an implementer's slot. The environment phase
// runs last, after the implementers, so the PRs it reads include this tick's.
//
// Every judgment call (is this worth building, which issue, how to
// implement/verify/review it) lives in an agent; the controller only sequences
// the handoffs and keeps the capacity gate.

import { resolve } from 'node:path';
import type { CodingWorker, CurrentRun, DepsRecord, EnvRecord, GroomRecord, ReviewRecord, RunHandle, RunRecord, RunResult, SecurityRecord, SimplifyRecord, Task, TokenUsage } from './types.ts';
import { agentCredentials, claudeBin, githubTokenForAgents, loadConfig, loadDotEnv, loadPrinciples, projectRoot, repoSlug, requireCursorApiKey, type FactoryConfig } from './config.ts';
import { RunBudgetExceeded } from './types.ts';
import { CursorWorker } from './worker.ts';
import { ClaudeCodeWorker } from './claudeCodeWorker.ts';
import { GitHubIssueSource } from './workSource.ts';
import { FactoryState } from './state.ts';
import { Telemetry } from './telemetry.ts';
import { filterAssigned, filterClaimed, filterEpics, parseSelection, type Selection } from './selector.ts';
import { BOOT_CHECK_PROMPT, depsPrompt, environmentPrompt, fixChecksPrompt, resolveConflictsPrompt, groomEpicPrompt, groomPrompt, implementPrompt, reviewPrompt, securityPrompt, selectPrompt, simplifyPrompt } from './prompts.ts';
import { factoryComment, isFactoryComment, groomState, isBlocker, isEpic, isGroomed, needsGroom, queueOrder, openChildren, openIssues, parseGroomReply, stampExtrasFor, unaccountedBlockers, verdict, type GroomLabels, type OpenIssues } from './groom.ts';
import { type PrCheck, addPrLabels, approveHeldRuns, awaitPrChecks, closePr, closePrQuietly, commentOnIssue, commentOnPr, createIssue, createPr, defaultBranchHead, ensureLabel, findPrByBranch, dismissCodeScanningAlert, listCodeScanningAlerts, listDependabotAlerts, listDependabotPrs, listPrsByLabel, listPrsForReview, markPrReady, mergePr, prChecks, prMergeable, prDrift, reopenPr, userId, viewPr, viewPrForReview } from './github.ts';
import { ENV_AGENT_MARK, environmentChangedAt, filedIssueBody, parseEnvReport, recentVerdicts, skipReason, unreadFactoryPrs, withOpenedThisTick, workerSkipReason, type UnreadPrs } from './environment.ts';
import { declinedSimplifications, recentlyMergedFactoryPrs, shrinks, skipReason as simplifySkipReason } from './simplify.ts';
import { carried, depsQueue, depsStamp, skipReason as depsSkipReason, type DepsPr } from './deps.ts';
import { alertKey, keysIn, offeredLine, parseFixReply, securityQueue, securityStamp, skipReason as securitySkipReason, type OfferedAlert, type SecurityAlert } from './security.ts';
import { coAuthorTrailer, isBot, parseReviewReply, reviewComment, reviewQueue, reviewStamp, sameCommit, skipReason as reviewSkipReason, staleReason, staleReport, touchesGithub, type ReviewOutcome, type ReviewPr, type ReviewReply } from './review.ts';

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
  if ((reply.verdict === 'done' && !epic) || (reply.verdict === 'close' && epic)) {
    throw new Error(`groom of #${task.issueNumber} answered "${reply.verdict}" where that verdict was not offered`);
  }
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
  log(`groomed #${task.issueNumber}${epic ? ' (epic)' : ''} → ${reply.verdict}${reply.notes ? ' (+notes)' : ''}${reply.blocked !== undefined ? ` (blocked on #${reply.blocked})` : ''}${epic && reply.waiting ? ` (waiting on ${reply.waiting.map((n) => `#${n}`).join(' ')})` : ''}`);

  // A groomed epic's children are the work; the verdict alone builds nothing.
  // Filed after the verdict is on record so a child always points at an epic
  // that already carries its decisions.
  // An epic's groom lets needs-work children go by naming them; a done epic
  // lets go of all of them. Only its own needs-work children: a groomed child,
  // or someone else's issue, is not the epic's to close.
  if (epic && open) {
    const needsWork = openChildren(task, open).filter((n) => verdict(open.get(n)!, ctx.config.labels) === 'needs-work');
    const named = new Set(reply.close ?? []);
    const dropped = reply.verdict === 'done' ? needsWork : needsWork.filter((n) => named.has(n));
    if (dropped.length > 0) {
      await ctx.source.dropChildren(task, dropped);
      log(`epic #${task.issueNumber}: closed needs-work child(ren) ${dropped.map((n) => `#${n}`).join(' ')} as not planned`);
    }
  }
  if (reply.verdict === 'done') {
    await ctx.source.closeEpic(task);
    log(`epic #${task.issueNumber} is done: closed`);
  }
  if (reply.verdict === 'close') {
    await ctx.source.closeTask(task);
    log(`#${task.issueNumber} has nothing to build: closed as not planned`);
  }

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

  const opened = await openedPr(config, result);

  if (opened) {
    await ensureLabel(repoSlug(config), config.labels.environmentPr, '1D76DB', 'Cloud-agent environment, opened by the software factory');
    await addPrLabels(repoSlug(config), opened, [config.labels.environmentPr]);
  }
  // The one rule the factory checks itself: the machine the PR describes boots
  // an agent carrying the implementers' credentials. One that does not is
  // closed before a human can merge it and take every run down with it.
  const bootFailure = opened ? await bootCheck(config, worker, opened) : null;
  if (opened && bootFailure) {
    await closePr(repoSlug(config), opened, factoryComment(
      `🏭 **Factory environment — closed.** Before this reached a human, the factory started an agent on this branch with the credentials every implementer is handed, and it did not boot and finish: ${bootFailure}. Merging it would have left every agent on a machine it cannot start. The branch is left for anyone who wants to find out why.`));
    log(`environment: closed ${opened} — an agent could not boot on it (${bootFailure}).`);
  }
  const envPrUrl = bootFailure ? null : opened;

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
    : opened
      ? `🏭 ${ENV_AGENT_MARK} Reading this PR${alongside} it found a gap in the cloud-agent environment and opened ${opened} to close it, but an agent could not boot on that environment, so the factory closed it.${filedNote} Its report:\n\n${report || '_(no report)_'}`
      : `🏭 ${ENV_AGENT_MARK} It read this PR${alongside} looking for a check that could not run in the cloud-agent environment, and opened none.${filedNote} Its report:\n\n${report || '_(no report)_'}`;
  for (const prUrl of prUrls) {
    await commentOnPr(repoSlug(config), prUrl, factoryComment(note)).catch((err: Error) => {
      log(`environment: could not comment on ${prUrl}: ${err.message}`);
    });
  }

  if (!bootFailure) log(envPrUrl
    ? `environment: opened ${envPrUrl}; it awaits a human and does not spend an implementer slot.`
    : `environment: no gap the environment could close${issuesFiled.length ? `; ${issuesFiled.length} repo defect(s) filed as issues` : ''}.`);
  return record({
    outcome: envPrUrl ? 'pr-opened' : opened ? 'unbootable' : 'no-gap',
    prUrl: opened,
    ...(bootFailure ? { bootFailure } : {}),
    ...(issuesFiled.length ? { issuesFiled } : {}),
  });
}

/**
 * Start one agent on the environment PR's branch, carrying the credentials
 * every implementer gets, and see whether it finishes. Returns why it did not,
 * or null. A failure to even launch the check is logged and counted as a pass:
 * the check exists to catch a broken machine, not a flaky API.
 */
async function bootCheck(config: FactoryConfig, worker: CodingWorker, prUrl: string): Promise<string | null> {
  const { headRefName } = await viewPr(repoSlug(config), prUrl);
  log(`environment: boot check — starting an agent on ${headRefName} with the implementers' credentials`);
  const handle = await worker.start(BOOT_CHECK_PROMPT, { startingRef: headRefName, autoCreatePR: false, name: 'factory-env-boot-check' }).catch((err: Error) => err);
  if (handle instanceof Error) {
    log(`environment: boot check could not launch (${handle.message}); not holding ${prUrl} to it`);
    return null;
  }
  const result = await worker.awaitResult(handle).catch((err: Error) => err);
  if (result instanceof Error) return result.message;
  if (result.status !== 'FINISHED') {
    const took = result.durationMs !== undefined ? ` after ${Math.round(result.durationMs / 1000)}s` : '';
    return `the agent ended ${result.status}${took}${result.resultText ? `: ${result.resultText.slice(0, 300)}` : ` (${worker.opaqueRunNote(handle)})`}`;
  }
  log(`environment: boot check passed on ${headRefName}`);
  return null;
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

/** The labels that mark a PR as the factory's own, whoever GitHub says opened it. */
function factoryPrLabels(config: FactoryConfig): string[] {
  return [config.labels.factoryPr, config.labels.environmentPr, config.labels.simplifyPr, config.labels.reviewPr, config.labels.depsPr, config.labels.securityPr];
}

/**
 * What the review phase would take up, read from GitHub in one place so the
 * tick, the dry run, and `factory status` agree. `reopen` is PRs the factory
 * closed whose author has replied since; they go first, because the author is
 * waiting on an answer they asked for.
 */
export async function reviewInputs(config: FactoryConfig): Promise<{ skip: string | null; open: ReviewPr[]; reopen: ReviewPr[] }> {
  const gate = reviewSkipReason(config.review.enabled, config.worker.kind);
  if (gate) return { skip: gate, open: [], reopen: [] };
  const repo = repoSlug(config);
  const [open, closed] = await Promise.all([
    listPrsForReview(repo, 'open', 100),
    listPrsForReview(repo, 'closed', 50),
  ]);
  const queue = reviewQueue([...open, ...closed], factoryPrLabels(config));
  const skip = queue.open.length + queue.reopen.length === 0 ? 'no PR from outside the factory is new or changed since the factory last reviewed it' : null;
  return { skip, ...queue };
}

/**
 * The review phase: PRs the factory did not open, one agent each, in parallel.
 * The agent decides — merge, close, or leave — and the controller acts, holding
 * a merge to the rules in review.ts. `only` reviews that one PR whether or not
 * it is due, the way `groom --force` does.
 */
export async function runReviewPhase(ctx: FactoryContext, worker: CodingWorker, opts: { only?: number } = {}): Promise<ReviewRecord[]> {
  const { config } = ctx;
  let picks: { pr: ReviewPr; reopened: boolean }[];
  if (opts.only !== undefined) {
    const gate = reviewSkipReason(true, config.worker.kind);
    if (gate) {
      log(`review: skipped — ${gate}.`);
      return [];
    }
    const pr = await viewPrForReview(repoSlug(config), String(opts.only));
    if (pr.state !== 'OPEN' || isBot(pr) || pr.labels.some((l) => factoryPrLabels(config).includes(l.name))) {
      log(`review: #${opts.only} is not an open PR from outside the factory; nothing to review.`);
      return [];
    }
    picks = [{ pr, reopened: false }];
  } else {
    const { skip, open, reopen } = await reviewInputs(config);
    if (skip) {
      log(`review: skipped — ${skip}.`);
      return [];
    }
    picks = [...reopen.map((pr) => ({ pr, reopened: true })), ...open.map((pr) => ({ pr, reopened: false }))].slice(0, config.review.maxPerTick);
  }

  log(`review: ${picks.length} PR(s) from outside the factory: ${picks.map((p) => `#${p.pr.number}${p.reopened ? ' (author replied to a close)' : ''}`).join(' ')}`);
  const principles = loadPrinciples(config);
  const records = await Promise.all(picks.map((p) =>
    reviewOne(ctx, worker, p.pr, p.reopened, principles).catch((err: Error) => {
      log(`review of #${p.pr.number} failed: ${err.message}`);
      return null;
    })));
  return records.filter((r): r is ReviewRecord => r !== null);
}

async function reviewOne(ctx: FactoryContext, worker: CodingWorker, pr: ReviewPr, reopened: boolean, principles: string): Promise<ReviewRecord | null> {
  const { config } = ctx;
  const repo = repoSlug(config);
  // Before an agent or a reopen: a stale PR is closed on what GitHub says alone,
  // and stamped, so it comes back only when its author replies or pushes.
  const stale = staleReason(await prDrift(repo, pr.url), config.review.maxCommitsBehind);
  if (stale) {
    const body = reviewComment('closed', staleReport(stale, config.review.maxCommitsBehind));
    await commentOnPr(repo, pr.url, factoryComment(`${reviewStamp(pr, 'closed')}\n${body}`));
    if (!reopened) await closePrQuietly(repo, pr.url);
    log(`review of #${pr.number}: closed without a review — ${stale} — ${pr.url}`);
    return null;
  }
  if (reopened) {
    await reopenPr(repo, pr.url);
    log(`review: reopened ${pr.url} — its author replied after the factory closed it`);
  }

  const startedAt = new Date().toISOString();
  // No credentials: this agent runs code nobody here wrote. A fork PR cannot be
  // checked out by Cursor or pushed to, so its agent starts on the default
  // branch, and a session branch it commits to becomes the replacement PR.
  const handle = await worker.start(reviewPrompt(pr, principles), {
    ...(pr.isCrossRepository ? { autoCreatePR: true } : { prUrl: pr.url }),
    withholdCredentials: true,
    name: `factory-review: #${pr.number} ${pr.title}`.slice(0, 100),
  });

  const record = async (over: Partial<ReviewRecord> & { verdict: ReviewRecord['verdict']; outcome: ReviewRecord['outcome'] }): Promise<ReviewRecord> => {
    const full: ReviewRecord = {
      type: 'review',
      prUrl: pr.url,
      prNumber: pr.number,
      author: pr.author.login,
      ...(reopened ? { reopened } : {}),
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

  // A review that reached no verdict leaves no stamp, so the next tick tries again.
  const result = await worker.awaitResult(handle).catch((err: Error) => err);
  if (result instanceof Error || result.status !== 'FINISHED') {
    const reason = result instanceof Error ? result.message : `run ended with status ${result.status}: ${result.resultText.slice(0, 300) || worker.opaqueRunNote(handle)}`;
    log(`review of #${pr.number}: ${reason}`);
    return record({ verdict: null, outcome: 'failed', reason });
  }
  // Labelled at once, like an implementer's PR, so no queue takes it for someone else's.
  const replacement = pr.isCrossRepository ? await replacementPr(config, pr, result) : null;
  if (replacement) {
    await ensureLabel(repo, config.labels.reviewPr, '5319E7', 'Replacement for an outside PR: its commits plus the factory review\'s fixes');
    await addPrLabels(repo, replacement, [config.labels.reviewPr]);
  }
  const reply = parseReviewReply(result.resultText);
  if (!reply) {
    log(`review of #${pr.number}: reply had no VERDICT line:\n${result.resultText.slice(0, 500)}`);
    if (replacement) await closePr(repo, replacement, factoryComment(`🏭 The review of ${pr.url} reached no verdict, so this replacement is closed.`)).catch(() => {});
    return record({ verdict: null, outcome: 'failed', reason: 'no VERDICT line' });
  }

  const act = await actOnReview(config, worker, handle, pr, reply, replacement).catch((err: Error) => err);
  if (act instanceof Error) {
    log(`review of #${pr.number}: could not act on "${reply.verdict}": ${act.message}`);
    return record({ verdict: reply.verdict, outcome: 'failed', reason: act.message.slice(0, 500), ...(replacement ? { replacementUrl: replacement } : {}) });
  }
  // Stamped against the PR as it stands now, so a push or a reply after this
  // comment is what brings it back. An unstamped note means "look again".
  const now = await viewPrForReview(repo, pr.url);
  const body = reviewComment(act.outcome, reply.report, act.note);
  await commentOnPr(repo, pr.url, factoryComment(act.stamped ? `${reviewStamp(now, act.outcome)}\n${body}` : body));
  if (act.outcome === 'closed' || act.outcome === 'superseded') await closePrQuietly(repo, pr.url);
  log(`review of #${pr.number}: agent answered ${reply.verdict}; ${act.outcome}${act.reason ? ` (${act.reason})` : ''}${replacement ? ` via ${replacement}` : ''} — ${pr.url}`);
  return record({ verdict: reply.verdict, outcome: act.outcome, ...(act.reason ? { reason: act.reason } : {}), ...(act.ci ?? {}), ...(replacement ? { replacementUrl: replacement } : {}) });
}

/**
 * The replacement a fork review's fixes landed in. The agent pushes its
 * session branch — nothing else does — and Cursor does not always open a PR
 * for it, since its history is the fork's, not the default branch's; so when
 * it reports a branch and no PR, the factory opens one. No commits on the branch means no fixes: gh refuses,
 * and there is no replacement.
 */
async function replacementPr(config: FactoryConfig, pr: ReviewPr, result: RunResult): Promise<string | null> {
  const opened = await openedPr(config, result);
  if (opened || !result.branch) return opened;
  try {
    return await createPr(repoSlug(config), result.branch, `${pr.title} (review fixes for #${pr.number})`,
      `🏭 Replacement for ${pr.url} by @${pr.author.login}: the author's commits with the factory review's fixes. The factory merges this in place of #${pr.number}, crediting the author, or closes it.`);
  } catch (err) {
    log(`review of #${pr.number}: no replacement from ${result.branch} — ${(err as Error).message.trim()}`);
    return null;
  }
}

type ReviewAct = { outcome: ReviewOutcome; stamped: boolean; note?: string; reason?: string; ci?: { fixRounds: number; checks: NonNullable<RunRecord['checks']> } };

/**
 * What the factory does with a review's verdict. Close and leave are the
 * agent's call alone. Merge is the agent's call held to the factory's rules:
 * the commit it names is the head of what gets merged — the PR itself, or for
 * a fork PR that needed fixes, the replacement its session branch became —
 * nothing under `.github/` changes, CI is green on it after at most one fix
 * round by the same agent, and GitHub's own rules allow the merge without an
 * admin bypass.
 */
async function actOnReview(
  config: FactoryConfig,
  worker: CodingWorker,
  handle: RunHandle,
  pr: ReviewPr,
  reply: ReviewReply,
  replacement: string | null,
): Promise<ReviewAct> {
  const repo = repoSlug(config);
  const discard = async (why: string) => {
    if (replacement) await closePr(repo, replacement, factoryComment(`🏭 Closed: ${why} See ${pr.url}.`));
  };
  if (reply.verdict === 'close') {
    await discard('the review closed the PR it was replacing.');
    return { outcome: 'closed', stamped: true };
  }
  if (reply.verdict === 'leave') {
    await discard('the review left the PR it was replacing for a human.');
    return { outcome: 'left', stamped: true };
  }

  const sha = reply.sha!;
  const before = await viewPrForReview(repo, pr.url);
  // Nothing here pushes to a fork, so its head the review started on, still
  // its head now, is the one the review saw.
  if (pr.isCrossRepository && before.headRefOid !== pr.headRefOid) {
    await discard('the PR it was replacing was pushed to during the review.');
    return headMoved(pr.headRefOid, before.headRefOid);
  }
  if (sameCommit(sha, before.headRefOid)) {
    await discard('the review merged the PR as it stands, without this.');
    return mergeVerified(config, worker, handle, pr.url, before);
  }
  if (!replacement) return pr.isCrossRepository ? fixesNotPushed(sha) : headMoved(sha, before.headRefOid);

  const rep = await viewPrForReview(repo, replacement);
  if (!sameCommit(sha, rep.headRefOid)) {
    await discard(`its head is ${rep.headRefOid.slice(0, 12)}, not ${sha.slice(0, 12)}, the commit the review verified.`);
    return headMoved(sha, rep.headRefOid);
  }
  const trailer = coAuthorTrailer(pr.author, await userId(pr.author.login));
  const merged = await mergeVerified(config, worker, handle, replacement, rep,
    `Supersedes #${pr.number} by @${pr.author.login}: the author's commits with the factory review's fixes.\n\n${trailer}`);
  if (merged.outcome !== 'merged') {
    return { ...merged, note: `${merged.note ?? ''} The review's fixes are in ${replacement}, left open.`.trim() };
  }
  return { ...merged, outcome: 'superseded', note: `Merged as ${replacement}, which carries your commits and the review's fixes; you are credited as co-author on the commit.` };
}

/** The review verified one commit and the PR now has another: nothing is merged, and it is looked at again. */
function headMoved(verified: string, head: string): ReviewAct {
  return {
    outcome: 'left',
    stamped: false,
    reason: 'head moved',
    note: `The review verified ${verified.slice(0, 12)}, but the head is now ${head.slice(0, 12)}, so nothing was merged; the factory reviews it again as it stands.`,
  };
}

/** A fork review named its own commit, and no branch on GitHub carries it: the fixes were never pushed. */
function fixesNotPushed(verified: string): ReviewAct {
  return {
    outcome: 'left',
    stamped: false,
    reason: 'fixes not pushed',
    note: `The review verified its fixes at ${verified.slice(0, 12)}, but they never reached a branch on GitHub, so nothing was merged; the factory reviews it again.`,
  };
}

/** Merge `target` at the head the agent verified, if the factory's rules allow. */
async function mergeVerified(
  config: FactoryConfig,
  worker: CodingWorker,
  handle: RunHandle,
  target: string,
  before: ReviewPr & { files: { path: string }[] },
  body?: string,
): Promise<ReviewAct> {
  const repo = repoSlug(config);
  const github = (paths: string[]): ReviewAct => ({
    outcome: 'left',
    stamped: true,
    reason: 'touches .github',
    note: `The factory would merge it, but it changes ${paths.map((p) => `\`${p}\``).join(', ')}, and the factory does not merge changes under \`.github/\`: they run with the repo's secrets.`,
  });
  if (touchesGithub(before.files).length > 0) return github(touchesGithub(before.files));

  // A fork's runs wait on a maintainer's approval, and the review that just
  // passed is that maintainer's read of the code; with `.github/` untouched,
  // the workflows that run are the repo's own.
  const approved = before.isCrossRepository ? await approveHeldRuns(repo, before.headRefOid) : 0;
  if (approved > 0) log(`${target}: approved ${approved} workflow run(s) held for a maintainer`);
  const ci = await greenChecks(config, worker, handle, target, { expectChecks: approved > 0 });
  const after = await viewPrForReview(repo, target);
  // Only the reviewer's own fix round may move the head; anything else is a
  // push nobody verified.
  if (ci.fixRounds === 0 && after.headRefOid !== before.headRefOid) return { ...headMoved(before.headRefOid, after.headRefOid), ci };
  if (touchesGithub(after.files).length > 0) return { ...github(touchesGithub(after.files)), ci };
  if (ci.checks === 'red') return { outcome: 'left', stamped: true, reason: 'checks red', note: 'The factory would merge it, but CI is still red after the agent\'s fix round.', ci };
  if (ci.checks === 'none') return { outcome: 'left', stamped: true, reason: 'no checks', note: 'The factory would merge it, but no CI reported on it, and the factory merges only on green checks.', ci };
  if (ci.checks === 'unsettled') return { outcome: 'left', stamped: true, reason: 'checks unsettled', note: `The factory would merge it, but CI had not finished within ${CHECKS_WAIT_MS / 60_000} minutes.`, ci };

  try {
    await mergePr(repo, target, after.headRefOid, body);
  } catch (err) {
    const msg = (err as Error).message.slice(0, 500);
    return { outcome: 'left', stamped: true, reason: `merge refused: ${msg}`, note: `The factory would merge it, but GitHub refused: ${msg}`, ci };
  }
  return { outcome: 'merged', stamped: true, ci };
}

/**
 * What the dependency phase would batch, read from GitHub in one place so the
 * tick, the dry run, and `factory status` agree.
 */
export async function depsInputs(config: FactoryConfig): Promise<{ skip: string | null; offered: DepsPr[] }> {
  const gate = depsSkipReason(config.deps.enabled, config.worker.kind);
  if (gate) return { skip: gate, offered: [] };
  const repo = repoSlug(config);
  const [open, batches] = await Promise.all([listDependabotPrs(repo), listPrsByLabel(repo, config.labels.depsPr, 'open')]);
  const skip = depsSkipReason(true, config.worker.kind, batches);
  if (skip) return { skip, offered: [] };
  const offered = depsQueue(open);
  return { skip: offered.length === 0 ? 'no Dependabot PR is new or changed since the last batch' : null, offered };
}

/**
 * The dependency phase: one agent carries every due Dependabot PR onto one
 * branch and regenerates what the repo installs from; the factory merges the
 * batch on green CI under the review phase's rules and closes what it carried.
 * See deps.ts for why the bumps are not merged one by one.
 *
 * Returns the record it wrote, or null when the pass did not run.
 */
export async function runDepsPhase(ctx: FactoryContext, worker: CodingWorker): Promise<DepsRecord | null> {
  const { config } = ctx;
  const repo = repoSlug(config);
  const { skip, offered } = await depsInputs(config);
  if (skip) {
    log(`deps: skipped — ${skip}.`);
    return null;
  }

  log(`deps: batching ${offered.length} Dependabot PR(s): ${offered.map((p) => `#${p.number}`).join(' ')}`);
  const startedAt = new Date().toISOString();
  // No credentials: it installs releases nobody here has read.
  const handle = await worker.start(depsPrompt(offered.map((p) => p.url)), { autoCreatePR: true, withholdCredentials: true, name: 'factory-deps' });

  const record = async (over: Partial<DepsRecord> & { outcome: DepsRecord['outcome'] }): Promise<DepsRecord> => {
    const full: DepsRecord = {
      type: 'deps',
      offered: offered.map((p) => p.url),
      carried: [],
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
  // Stamped at the head the batch was offered, so a rebase since brings it back.
  const conclude = async (prs: DepsPr[], body: string, close: boolean) => {
    for (const p of prs) {
      try {
        await commentOnPr(repo, p.url, factoryComment(`${depsStamp(p)}\n${body}`));
        if (close) await closePrQuietly(repo, p.url);
      } catch (err) {
        log(`deps: could not conclude on ${p.url}: ${(err as Error).message}`);
      }
    }
  };

  // A batch that reached no conclusion stamps nothing, so the next tick tries again.
  const result = await worker.awaitResult(handle).catch((err: Error) => err);
  if (result instanceof Error || result.status !== 'FINISHED') {
    const reason = result instanceof Error ? result.message : `run ended with status ${result.status}: ${result.resultText.slice(0, 300) || worker.opaqueRunNote(handle)}`;
    log(`deps: batch failed — ${reason}`);
    return record({ outcome: 'failed', reason });
  }

  const prUrl = await openedPr(config, result);
  if (!prUrl) {
    log(`deps: the agent carried none of them. Its report:\n${result.resultText.trim() || '_(no report)_'}`);
    await conclude(offered, `🏭 **Factory dependency batch — left for a human.** The factory's batch agent could not carry any of the open Dependabot PRs. Its report:\n\n${result.resultText.trim() || '_(no report)_'}`, false);
    return record({ outcome: 'no-pr' });
  }
  // Labelled at once, so the review phase never takes it for someone else's.
  await ensureLabel(repo, config.labels.depsPr, '0366D6', 'Dependabot PRs batched by the software factory, lockfile regenerated');
  await addPrLabels(repo, prUrl, [config.labels.depsPr]);

  const act = await mergeVerified(config, worker, handle, prUrl, await viewPrForReview(repo, prUrl)).catch((err: Error): ReviewAct =>
    ({ outcome: 'left', stamped: true, reason: err.message.slice(0, 500), note: `The factory could not merge it: ${err.message.slice(0, 500)}` }));
  const numbers = carried((await viewPr(repo, prUrl)).body, offered.map((p) => p.number));
  const took = offered.filter((p) => numbers.includes(p.number));
  const dropped = offered.filter((p) => !numbers.includes(p.number));
  const merged = act.outcome === 'merged';

  if (!merged) {
    await commentOnPr(repo, prUrl, factoryComment(`🏭 **Factory dependency batch — left for a human.** ${act.note ?? ''}`.trim())).catch(() => {});
  }
  await conclude(took, merged
    ? `🏭 **Factory dependency batch — merged.** This bump landed in ${prUrl}, with the lockfile regenerated from it, on green CI; closing this one.`
    : `🏭 **Factory dependency batch.** This bump is carried in ${prUrl}, which the factory could not merge and has left for a human.`, merged);
  await conclude(dropped, `🏭 **Factory dependency batch — left for a human.** ${prUrl} batched the open Dependabot PRs and left this one out; its description says why.`, false);

  log(`deps: ${prUrl} carries ${took.length} of ${offered.length}; ${merged ? 'merged' : `left (${act.reason})`}${dropped.length ? `; left open: ${dropped.map((p) => `#${p.number}`).join(' ')}` : ''}`);
  return record({
    outcome: merged ? 'merged' : 'left',
    prUrl,
    carried: took.map((p) => p.url),
    ...(act.reason ? { reason: act.reason } : {}),
    ...(act.ci ?? {}),
  });
}

/**
 * What the security phase would fix, read from GitHub in one place so the
 * tick, the dry run, and `factory status` agree. An alert source the tick
 * cannot read — off for this repo, or a token without security access — is
 * left out and named; with neither readable there is nothing to fix.
 */
export async function securityInputs(config: FactoryConfig): Promise<{ skip: string | null; offered: OfferedAlert[]; openPrs: string[] }> {
  const { enabled, minSeverity } = config.security;
  const gate = securitySkipReason(enabled, config.worker.kind);
  if (gate) return { skip: gate, offered: [], openPrs: [] };
  const repo = repoSlug(config);
  const unreadable: string[] = [];
  const read = (what: string, list: Promise<SecurityAlert[]>) => list.catch((err: Error) => {
    unreadable.push(`${what} (${err.message.split('\n')[0]!.slice(0, 200)})`);
    return [];
  });
  const [dependabot, codeScanning, prs] = await Promise.all([
    read('Dependabot alerts', listDependabotAlerts(repo)),
    read('code scanning alerts', listCodeScanningAlerts(repo)),
    listPrsByLabel(repo, config.labels.securityPr, 'all', 500),
  ]);
  if (unreadable.length === 2) return { skip: `cannot read the repo's alerts: ${unreadable.join('; ')}`, offered: [], openPrs: [] };
  if (unreadable.length) log(`security: leaving out ${unreadable[0]}`);
  const open = prs.filter((p) => p.state === 'OPEN');
  const { offered, held } = securityQueue([...dependabot, ...codeScanning], prs, minSeverity);
  return {
    skip: securitySkipReason(true, config.worker.kind, open, { offered: offered.length, held }),
    offered,
    openPrs: open.map((p) => p.url),
  };
}

function securityPromptFor(config: FactoryConfig, inputs: { offered: OfferedAlert[]; openPrs: string[] }): string {
  return securityPrompt({ alerts: inputs.offered.map(offeredLine), openPrs: inputs.openPrs, budget: { maxRunMinutes: config.worker.maxRunMinutes } });
}

/**
 * The security phase: one agent takes the most severe group of open alerts no
 * factory PR claims that one PR can fix, and opens that PR. The factory claims
 * the alerts on it, hands a red check back, and leaves it for a human, like an
 * implementer's. See security.ts for why there is no issue in between.
 *
 * Returns the record it wrote, or null when the pass did not run.
 */
export async function runSecurityPhase(ctx: FactoryContext, worker: CodingWorker): Promise<SecurityRecord | null> {
  const { config } = ctx;
  const repo = repoSlug(config);
  const inputs = await securityInputs(config);
  if (inputs.skip) {
    log(`security: skipped — ${inputs.skip}.`);
    return null;
  }
  const { offered } = inputs;
  const keys = offered.map((o) => alertKey(o.alert));
  log(`security: handing ${offered.length} open alert(s) at ${config.security.minSeverity} or above to a fixer`);
  const startedAt = new Date().toISOString();
  // No credentials: upgrading a dependency runs a release nobody here has read.
  const handle = await worker.start(securityPromptFor(config, inputs), { autoCreatePR: true, withholdCredentials: true, name: 'factory-security' });

  const record = async (over: Partial<SecurityRecord> & { outcome: SecurityRecord['outcome'] }): Promise<SecurityRecord> => {
    const full: SecurityRecord = {
      type: 'security',
      offered: keys,
      fixed: [],
      dismissed: [],
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
    const reason = result instanceof Error ? result.message : `run ended with status ${result.status}: ${result.resultText.slice(0, 300) || worker.opaqueRunNote(handle)}`;
    log(`security: fix failed — ${reason}`);
    return record({ outcome: 'failed', failureReason: reason });
  }

  const reply = parseFixReply(result.resultText, keys);
  const dismissed: string[] = [];
  for (const { key, reason } of reply.dismiss) {
    try {
      await dismissCodeScanningAlert(repo, Number(key.split('#')[1]), `Factory security agent: ${reason}`);
      dismissed.push(key);
      log(`security: dismissed ${key} as a false positive — ${reason}`);
    } catch (err) {
      log(`security: could not dismiss ${key}: ${(err as Error).message}`);
    }
  }

  const prUrl = await openedPr(config, result);
  if (!prUrl) {
    log(`security: no PR. The agent's report:\n${result.resultText.trim() || '_(no report)_'}`);
    return record({ outcome: 'no-pr', dismissed });
  }
  // Labelled and claimed before the CI wait: an unlabelled PR is one the review
  // phase would take for someone else's, and an unclaimed alert is one the
  // next pass would fix again.
  await ensureLabel(repo, config.labels.securityPr, 'D93F0B', 'Fixes open security alerts; opened by the software factory');
  await addPrLabels(repo, prUrl, [config.labels.securityPr]);
  // An agent that forgot its ALERTS line still named them in its PR, most likely.
  const fixed = reply.fixed.length > 0
    ? reply.fixed
    : keysIn((await viewPr(repo, prUrl)).body).filter((k, i, all) => keys.includes(k) && !dismissed.includes(k) && all.indexOf(k) === i);
  const url = new Map(offered.map((o) => [alertKey(o.alert), o.alert.url]));
  if (fixed.length > 0) {
    await commentOnPr(repo, prUrl, factoryComment(`${securityStamp(fixed)}\n🏭 **Factory security fix** for ${fixed.map((k) => `[${k}](${url.get(k)})`).join(', ')}. GitHub closes each once this reaches the default branch; one still open a day after the merge is offered to the factory again.`));
  } else {
    log(`security: ${prUrl} names none of the alerts it was handed; nothing is claimed, so the next pass is offered them again`);
  }
  const ci = await greenChecks(config, worker, handle, prUrl);
  log(`security: ${prUrl} fixes ${fixed.length} of ${offered.length} alert(s) (checks ${ci.checks}); it awaits a human${dismissed.length ? `; dismissed ${dismissed.join(' ')}` : ''}.`);
  return record({ outcome: 'pr-opened', prUrl, fixed, dismissed, ...ci });
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
  await handBackStuckPrs(ctx, worker);

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
  //    Reviews of PRs from outside the factory run alongside too: they take
  //    no slot and touch no issue, and their PRs are not the factory's. So
  //    does the dependency batch, for the same reasons, and the security
  //    fix, whose PR is its own queue as theirs are.
  const [, openedThisTick] = await Promise.all([
    runSimplifyPhase(ctx, worker).catch((err: Error) => {
      log(`simplify phase error: ${err.message}`);
      return null;
    }),
    runImplementation(ctx, worker, candidates),
    runReviewPhase(ctx, worker).catch((err: Error) => {
      log(`review phase error: ${err.message}`);
      return [];
    }),
    runDepsPhase(ctx, worker).catch((err: Error) => {
      log(`deps phase error: ${err.message}`);
      return null;
    }),
    runSecurityPhase(ctx, worker).catch((err: Error) => {
      log(`security phase error: ${err.message}`);
      return null;
    }),
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

  const review = await reviewInputs(config);
  if (review.skip) {
    log(`review: would skip — ${review.skip}.`);
  } else {
    const due = [...review.reopen, ...review.open];
    log(`review: would review ${Math.min(due.length, config.review.maxPerTick)} of ${due.length} PR(s) from outside the factory — ${due.map((p) => `#${p.number}${review.reopen.includes(p) ? ' (reopen)' : ''}`).join(' ')}. Prompt for #${due[0]!.number}:`);
    console.log(`\n${reviewPrompt(due[0]!, '<principles.md>')}\n`);
  }

  const deps = await depsInputs(config);
  if (deps.skip) {
    log(`deps: would skip — ${deps.skip}.`);
  } else {
    log(`deps: would batch ${deps.offered.length} Dependabot PR(s). Its prompt would be:`);
    console.log(`\n${depsPrompt(deps.offered.map((p) => p.url))}\n`);
  }

  const security = await securityInputs(config);
  if (security.skip) {
    log(`security: would skip — ${security.skip}.`);
  } else {
    log(`security: would hand ${security.offered.length} open alert(s) to a fixer. Its prompt would be:`);
    console.log(`\n${securityPromptFor(config, security)}\n`);
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
  // Labelled before the CI wait, not after: an unlabelled PR is one the review
  // phase would take for someone else's, and a crash mid-wait would leave it so.
  if (prUrl) {
    current.prUrl = prUrl;
    state.writeRun(current);
    await addPrLabels(repoSlug(config), prUrl, [config.labels.factoryPr]);
  }
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
 * Follow-up rounds an implementer gets, within its own pipeline, to turn red CI
 * green. A red PR fills a slot until a human acts, and three of them stall the
 * factory: on Oct 1 one flaky test held every slot while each agent, after its
 * one round, reported it as not theirs. A PR still red when its pipeline ends
 * is handed back again by later ticks (`handBackStuckPrs`).
 */
const FIX_ROUNDS = 3;
/** Ticks that hand one PR's red checks, or its conflicts, back before it is left to a human. */
const MAX_HANDBACKS = 3;
const HANDBACK_NOTE = 'Handed the failing checks back to the agent that opened this';
const CONFLICT_NOTE = 'Handed the merge conflicts back to the agent that opened this';

/**
 * Whether a PR's checks are red and settled: something failed and nothing is
 * still running, so a push from a handback already sent is not mistaken for
 * a new failure. Null when there is nothing to hand back.
 */
export function redChecks(checks: PrCheck[]): PrCheck[] | null {
  if (checks.some((c) => c.bucket === 'pending')) return null;
  const failed = checks.filter((c) => c.bucket === 'fail');
  return failed.length > 0 ? failed : null;
}

/** How many ticks have already handed this PR back for one reason, from its own comments. */
export function handbacksSent(comments: { body: string }[], note = HANDBACK_NOTE): number {
  return comments.filter((c) => isFactoryComment(c.body) && c.body.includes(note)).length;
}

/**
 * Every open factory PR that cannot merge, at the start of a tick, goes back to
 * the agent that opened it. Conflicts first: parallel work merged ahead of it,
 * and GitHub runs no CI on a PR that conflicts, so its checks mean nothing
 * until they are resolved. Otherwise red checks: its pipeline ran out of
 * rounds, died, or the failure came from main after it finished. Either fills
 * a slot until someone acts. Fire and forget — the agent pushes, CI runs, and
 * the PR is merged green or handed back again next tick, up to MAX_HANDBACKS
 * per reason. Workers whose agents do not outlive the tick skip this.
 */
async function handBackStuckPrs(ctx: FactoryContext, worker: CodingWorker): Promise<void> {
  if (!worker.agentForPr) return;
  const { config } = ctx;
  const repo = repoSlug(config);
  const open = (await Promise.all([config.labels.factoryPr, config.labels.environmentPr, config.labels.simplifyPr, config.labels.securityPr]
    .map((label) => listPrsByLabel(repo, label, 'open')))).flat();
  for (const pr of open) {
    try {
      const { mergeable, baseRefName } = await prMergeable(repo, pr.url);
      const stuck = mergeable === 'CONFLICTING'
        ? { note: CONFLICT_NOTE, what: `merge conflicts with ${baseRefName}`, prompt: resolveConflictsPrompt(pr.url, baseRefName) }
        : await (async () => {
          const failed = redChecks(await prChecks(repo, pr.url));
          const names = failed?.map((c) => c.name).join(', ');
          return failed ? { note: HANDBACK_NOTE, what: `failing check(s) ${names}`, prompt: fixChecksPrompt(pr.url, failed) } : null;
        })();
      if (!stuck) continue;
      const sent = handbacksSent(pr.comments, stuck.note);
      if (sent >= MAX_HANDBACKS) {
        log(`${pr.url}: ${stuck.what} still, after ${sent} handback(s); leaving it to a human`);
        continue;
      }
      const agent = await worker.agentForPr(pr.url);
      if (!agent) {
        log(`${pr.url}: ${stuck.what}, but no agent to hand it back to`);
        continue;
      }
      await worker.continueRun(agent, stuck.prompt);
      await commentOnPr(repo, pr.url, factoryComment(`🏭 ${stuck.note} (${sent + 1} of ${MAX_HANDBACKS}): ${stuck.what}.`));
      log(`${pr.url}: handed ${stuck.what} back to its agent`);
    } catch (err) {
      log(`${pr.url}: could not hand it back — ${(err as Error).message}`);
    }
  }
}

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
  opts: { expectChecks?: boolean } = {},
): Promise<{ fixRounds: number; checks: NonNullable<RunRecord['checks']> }> {
  const repo = repoSlug(config);
  const poll = { maxWaitMs: CHECKS_WAIT_MS, pollMs: config.worker.pollIntervalSeconds * 1000, log };
  let fixRounds = 0;
  let { failed, settled } = await awaitPrChecks(repo, prUrl, { ...poll, expectChecks: opts.expectChecks === true });
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
