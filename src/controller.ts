// The factory controller: one idempotent tick.
//
//   reconcile outcomes → groom ungroomed issues → fix the agents' environment →
//   measure free capacity → for each free slot, a selector agent picks the most
//   well-scoped GROOMED issue → hand each to a FRESH implementer agent → label
//   the resulting PRs → record telemetry → yield to a human.
//
// `maxConcurrentJobs` is the whole throttle: a job is an open factory PR
// awaiting a human or a pipeline still running, at most that many exist at
// once, and so one tick starts at most that many pipelines. Default 1 keeps the
// strict one-at-a-time factory.
//
// Grooming and the environment phase both run before the capacity gate on
// purpose: neither touches product code, so a PR sitting in review is no reason
// to stop vetting the backlog or to leave the agents' machine broken. An
// environment PR is its own one-deep queue and never spends an implementer's
// slot — the two can never collide, since one touches only `.cursor/`.
//
// Every judgment call (is this worth building, which issue, how to
// implement/verify/review it) lives in an agent; the controller only sequences
// the handoffs and keeps the capacity gate.

import { resolve } from 'node:path';
import type { CodingWorker, CurrentRun, EnvRecord, GroomRecord, Task, TokenUsage } from './types.ts';
import { loadConfig, loadDotEnv, loadPrinciples, projectRoot, repoSlug, requireCursorApiKey, type FactoryConfig } from './config.ts';
import { CursorWorker } from './worker.ts';
import { GitHubIssueSource } from './workSource.ts';
import { FactoryState } from './state.ts';
import { Telemetry } from './telemetry.ts';
import { filterAssigned, filterClaimed, parseSelection, type Selection } from './selector.ts';
import { environmentPrompt, groomPrompt, implementPrompt, selectPrompt } from './prompts.ts';
import { factoryComment, groomState, isGroomed, needsGroom, parseGroomReply, verdict } from './groom.ts';
import { addPrLabels, commentOnIssue, commentOnPr, defaultBranchHead, ensureLabel, findPrByBranch, listPrsByLabel } from './github.ts';
import { environmentChangedAt, skipReason, unreadFactoryPrs } from './environment.ts';

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
 * same commit and none can be handed a stale clone.
 */
export async function buildWorker(config: FactoryConfig): Promise<CursorWorker> {
  const { branch, sha } = await defaultBranchHead(repoSlug(config));
  log(`agents will start from ${branch} @ ${sha.slice(0, 8)}`);
  return new CursorWorker({
    apiKey: requireCursorApiKey(),
    repoUrl: config.repo.url,
    startingRef: sha,
    model: config.worker.model,
    pollIntervalSeconds: config.worker.pollIntervalSeconds,
    maxRunMinutes: config.worker.maxRunMinutes,
    log,
  });
}

/** Open issues the factory has not already claimed. */
export async function candidateTasks(ctx: FactoryContext): Promise<Task[]> {
  const tasks = await ctx.source.eligibleTasks();
  return filterClaimed(tasks, ctx.config.labels.issueInProgress);
}

/**
 * The candidates one phase may act on. Both phases start from the same list —
 * an extra issue-list call per phase would only widen the window in which the
 * two disagree — and differ only in whether a human's assignment excludes it.
 */
export function admissible(ctx: FactoryContext, tasks: Task[], phase: 'groom' | 'implement'): Task[] {
  return ctx.config.assignedIssues[phase] ? tasks : filterAssigned(tasks);
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
  opts: { limit?: number; force?: boolean } = {},
): Promise<GroomRecord[]> {
  const pending = needsGroom(candidates, ctx.config.labels, opts.force).slice(0, opts.limit ?? ctx.config.groom.maxPerTick);
  if (pending.length === 0) return [];

  const principles = loadPrinciples(ctx.config);
  log(`grooming ${pending.length} issue(s): ${pending.map((t) => `#${t.issueNumber}`).join(' ')}`);

  const records = await Promise.all(
    pending.map((task) =>
      groomOne(ctx, worker, task, principles).catch((err) => {
        log(`groom #${task.issueNumber} failed: ${(err as Error).message}`);
        return null;
      }),
    ),
  );
  return records.filter((r): r is GroomRecord => r !== null);
}

async function groomOne(
  ctx: FactoryContext,
  worker: CodingWorker,
  task: Task,
  principles: string,
): Promise<GroomRecord> {
  const startedAt = new Date().toISOString();
  const handle = await worker.start(groomPrompt(task, principles), {
    autoCreatePR: false,
    name: `factory-groom: #${task.issueNumber}`.slice(0, 100),
  });
  const result = await worker.awaitResult(handle);
  if (result.status !== 'FINISHED') {
    throw new Error(`groom run ended with status ${result.status}: ${result.resultText.slice(0, 300)}`);
  }
  const reply = parseGroomReply(result.resultText);
  if (!reply) {
    throw new Error(`groom reply had no VERDICT line:\n${result.resultText.slice(0, 500)}`);
  }

  await ctx.source.recordGroom(task, reply);
  log(`groomed #${task.issueNumber} → ${reply.verdict}${reply.notes ? ' (+notes)' : ''}`);

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
    worker: 'cursor',
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
    throw new Error(`selector run ended with status ${result.status}: ${result.resultText.slice(0, 300)}`);
  }
  const usage = (await worker.usage(handle.agentId)) ?? null;
  return {
    selection: parseSelection(result.resultText, tasks),
    agentId: handle.agentId,
    usage,
    reply: result.resultText,
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
): Promise<EnvRecord | null> {
  const { config } = ctx;
  const openEnvPrs = config.environment.enabled
    ? await listPrsByLabel(repoSlug(config), config.labels.environmentPr, 'open')
    : [];
  const changedAt = environmentChangedAt(ctx.telemetry.outcomes());
  const unread = unreadFactoryPrs(ctx.telemetry.runs(), ctx.telemetry.envPasses(), changedAt);
  const skip = skipReason(config.environment.enabled, openEnvPrs, unread, changedAt);
  if (skip) {
    log(`environment: skipped — ${skip}.`);
    return null;
  }

  const prUrls = unread.fresh.slice(0, config.environment.maxPrsPerPass);
  log(`environment: reading ${prUrls.length} factory PR(s) for verification the agents could not run: ${prUrls.join(' ')}`);

  const startedAt = new Date().toISOString();
  const handle = await worker.start(environmentPrompt(prUrls), {
    autoCreatePR: true,
    name: 'factory-env',
  });

  const record = async (over: Partial<EnvRecord>): Promise<EnvRecord> => {
    const full: EnvRecord = {
      type: 'env',
      prsExamined: prUrls,
      outcome: 'no-gap',
      prUrl: null,
      worker: 'cursor',
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

  const envPrUrl =
    result.prUrl ??
    (result.branch ? (await findPrByBranch(repoSlug(config), result.branch))?.url : undefined) ??
    null;

  if (envPrUrl) {
    await ensureLabel(repoSlug(config), config.labels.environmentPr, '1D76DB', 'Cloud-agent environment, opened by the software factory');
    await addPrLabels(repoSlug(config), envPrUrl, [config.labels.environmentPr]);
  }

  // Either way the finding belongs on the PRs that produced it — that is where
  // the human who hit the blocked check is looking.
  const alongside = prUrls.length > 1 ? ` (alongside ${prUrls.length - 1} other recent factory PR${prUrls.length > 2 ? 's' : ''})` : '';
  const note = envPrUrl
    ? `🏭 **Factory environment agent.** Reading this PR${alongside} it found a gap in the cloud-agent environment and opened ${envPrUrl} to close it.`
    : `🏭 **Factory environment agent.** It read this PR${alongside} looking for a check that could not run in the cloud-agent environment, and opened none. Its report:\n\n${result.resultText.trim() || '_(no report)_'}`;
  for (const prUrl of prUrls) {
    await commentOnPr(repoSlug(config), prUrl, factoryComment(note)).catch((err: Error) => {
      log(`environment: could not comment on ${prUrl}: ${err.message}`);
    });
  }

  log(envPrUrl
    ? `environment: opened ${envPrUrl}; it awaits a human and does not spend an implementer slot.`
    : 'environment: no gap the environment could close.');
  return record({ outcome: envPrUrl ? 'pr-opened' : 'no-gap', prUrl: envPrUrl });
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
  if (candidates.length > 0) await runGroomPhase(ctx, worker, admissible(ctx, candidates, 'groom'));

  // 3. Environment: fix the machine the implementers run on, from what the
  //    implementers themselves said about it. Also ahead of the capacity gate,
  //    and its PR is its own one-deep queue. Deliberately independent of the
  //    backlog too: a machine that cannot verify stays broken whether or not
  //    there is anything to build on it today, and the tick that notices is the
  //    idle one.
  await runEnvironmentPhase(ctx, worker).catch((err: Error) => {
    log(`environment phase error: ${err.message}`);
    return null;
  });

  if (candidates.length === 0) {
    log('no open unclaimed issues. Nothing to implement.');
    return;
  }

  // 4. Capacity gate, for the implementation half only.
  const capacity = await ctx.state.capacity(log);
  log(`capacity: ${capacity.slots} of ${capacity.limit} slot(s) free (${capacity.openPrs.length} PR(s) awaiting a human, ${capacity.inFlight.length} pipeline(s) in flight)`);
  if (capacity.slots === 0) {
    for (const pr of capacity.openPrs) log(`  awaiting human: ${pr.url} ("${pr.title}")`);
    for (const run of capacity.inFlight) {
      log(`  in flight: ${run.taskId} (agent ${run.agentId}). Use \`factory abort\` if it is dead.`);
    }
    log('implementation paused until a human clears a slot.');
    return;
  }

  // 5. Selector agents fill the free slots. Re-fetch, since the groom phase
  //    just rewrote some of the bodies we hold.
  const tasks = admissible(ctx, await candidateTasks(ctx), 'implement').filter((t) => isGroomed(t, ctx.config.labels));
  if (tasks.length === 0) {
    log('no groomed issues available to implement. Nothing to do.');
    return;
  }

  await ensureLabel(repoSlug(config), config.labels.factoryPr, '0E8A16', 'Opened by the software factory');
  const picks = await pickTasks(ctx, worker, tasks, capacity.slots);
  if (picks.length === 0) return;

  // 6. Handoff: one fresh implementer session per pick, run concurrently. They
  //    work on separate branches, so the only collisions are ones a human
  //    resolves at review time — the same as two people picking up two issues.
  await Promise.all(
    picks.map((pick) =>
      runPipeline(ctx, worker, pick.task, pick.agentId, pick.usage).catch(async (err) => {
        log(`pipeline error for #${pick.task.issueNumber}: ${(err as Error).message}`);
        await failRun(ctx, worker, pick.task, (err as Error).message);
      }),
    ),
  );
}

interface Pick {
  task: Task;
  agentId: string;
  usage: TokenUsage | null;
}

/**
 * One selector run per free slot, each over the issues the earlier runs did not
 * take. Sequential on purpose: a pick has to see the previous claims, and the
 * issue is labelled `factory:wip` as soon as it is picked.
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
    log(`handing ${remaining.length} groomed issue(s) to the selector agent (slot ${picks.length + 1} of ${slots})`);
    const picked = await runSelector(worker, remaining);

    if (picked.selection.kind === 'none') {
      log(`selector picked nothing. Its reasoning:\n${picked.reply}`);
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
  const candidates = admissible(ctx, allCandidates, 'groom');
  const pending = needsGroom(candidates, ctx.config.labels);
  const groomed = admissible(ctx, allCandidates, 'implement').filter((t) => isGroomed(t, ctx.config.labels));
  const heldBack = allCandidates.length - candidates.length;
  if (heldBack > 0) log(`${heldBack} assigned issue(s) held back from grooming.`);
  const needsWork = candidates.filter((t) => verdict(t, ctx.config.labels) === 'needs-work').length;
  const assignedGroomed = allCandidates.filter((t) => t.assignees.length > 0 && isGroomed(t, ctx.config.labels)).length;
  if (!ctx.config.assignedIssues.implement && assignedGroomed > 0) {
    log(`${assignedGroomed} groomed issue(s) withheld from the selector: assigned to a human.`);
  }
  // The buckets overlap: a groomed issue someone has since replied to is both
  // implementable and queued for another look.
  log(`dry run: ${candidates.length} unclaimed issue(s) — ${groomed.length} groomed, ${needsWork} needs-work, ${candidates.length - groomed.length - needsWork} never groomed (${pending.length} queued for a groom)`);

  const next = pending.slice(0, ctx.config.groom.maxPerTick);
  if (next.length > 0) {
    log(`would groom: ${next.map((t) => `#${t.issueNumber}`).join(' ')}. Groom prompt for #${next[0]!.issueNumber}:`);
    console.log(`\n${groomPrompt(next[0]!, loadPrinciples(ctx.config))}\n`);
  }
  if (groomed.length > 0) {
    log('selector prompt would be:');
    console.log(`\n${selectPrompt(groomed)}\n`);
  }

  const { config } = ctx;
  const openEnvPrs = config.environment.enabled
    ? await listPrsByLabel(repoSlug(config), config.labels.environmentPr, 'open')
    : [];
  const changedAt = environmentChangedAt(ctx.telemetry.outcomes());
  const unread = unreadFactoryPrs(ctx.telemetry.runs(), ctx.telemetry.envPasses(), changedAt);
  const skip = skipReason(config.environment.enabled, openEnvPrs, unread, changedAt);
  if (skip) {
    log(`environment: would skip — ${skip}.`);
    return;
  }
  const prUrls = unread.fresh.slice(0, config.environment.maxPrsPerPass);
  log(`environment: would read ${prUrls.length} of ${unread.fresh.length} unread factory PR(s)${unread.stale.length ? `, ignoring ${unread.stale.length} written before the environment changed` : ''}. Its prompt would be:`);
  console.log(`\n${environmentPrompt(prUrls)}\n`);
}

async function runPipeline(
  ctx: FactoryContext,
  worker: CodingWorker,
  task: Task,
  selectorAgentId: string,
  selectorUsage: TokenUsage | null,
): Promise<void> {
  const { config, state } = ctx;
  const startedAt = new Date().toISOString();

  const handle = await worker.start(implementPrompt(task), {
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
    throw new Error(`run ended with status ${result.status}: ${result.resultText.slice(0, 300)}`);
  }

  const usage = (await worker.usage(handle.agentId)) ?? null;
  const prUrl =
    result.prUrl ??
    (result.branch ? (await findPrByBranch(repoSlug(config), result.branch))?.url : undefined) ??
    null;

  if (!prUrl) {
    // The agent chose not to open a PR; surface its explanation on the issue.
    log(`no PR opened for #${task.issueNumber}; relaying the agent's explanation to the issue`);
    if (result.resultText.trim()) {
      await commentOnIssue(repoSlug(config), task.issueNumber, factoryComment(
        `🏭 The factory attempted this issue but did not open a PR. Agent's report:\n\n${result.resultText}`));
    }
    await ctx.source.markFinished(task);
  } else {
    current.prUrl = prUrl;
    state.writeRun(current);
    await addPrLabels(repoSlug(config), prUrl, [config.labels.factoryPr]);
    const pause = pauseNote(config);
    await commentOnIssue(repoSlug(config), task.issueNumber, factoryComment(
      `🏭 The factory opened ${prUrl} for this issue. It is awaiting human review; ${pause}.`));
    log(`done: ${prUrl} awaits human review; ${pause}.`);
  }

  ctx.telemetry.append({
    type: 'run',
    taskId: task.id,
    issueNumber: task.issueNumber,
    issueTitle: task.title,
    worker: 'cursor',
    model: config.worker.model,
    agentId: handle.agentId,
    selectorAgentId,
    startedAt,
    finishedAt: new Date().toISOString(),
    outcome: prUrl ? 'pr-opened' : 'no-pr',
    prUrl,
    usage,
    selectorUsage,
    durationMs: Date.now() - Date.parse(startedAt),
  });
  state.clearRun(task.id);
}

/** How the factory describes its own throttle, given the job cap. */
function pauseNote(config: FactoryConfig): string {
  return config.maxConcurrentJobs === 1
    ? 'the factory is paused until it is merged or closed'
    : `the factory runs up to ${config.maxConcurrentJobs} jobs at a time`;
}

async function failRun(ctx: FactoryContext, worker: CodingWorker, task: Task, reason: string): Promise<void> {
  const current = ctx.state.readRun(task.id);
  ctx.telemetry.append({
    type: 'run',
    taskId: task.id,
    issueNumber: task.issueNumber,
    issueTitle: task.title,
    worker: 'cursor',
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
  // Release the issue so a future tick can retry or pick something else. If a
  // PR was created before the failure, it carries the factory label and holds
  // its slot until a human deals with it.
  await ctx.source.markFinished(task);
  ctx.state.clearRun(task.id);
}
