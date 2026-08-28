// The factory controller: one idempotent tick.
//
//   reconcile outcomes → groom ungroomed issues → stop if a job is active →
//   selector agent picks the most well-scoped GROOMED issue → hand it to a
//   FRESH implementer agent → label the resulting PR → record telemetry →
//   yield to a human.
//
// Grooming runs before the active-job gate on purpose: it never touches code,
// so a PR sitting in review is no reason to stop vetting the backlog.
//
// Every judgment call (is this worth building, which issue, how to
// implement/verify/review it) lives in an agent; the controller only sequences
// the handoffs and keeps the single-active-job invariant.

import { resolve } from 'node:path';
import type { CodingWorker, CurrentRun, GroomRecord, Task, TokenUsage } from './types.ts';
import { loadConfig, loadDotEnv, loadPrinciples, projectRoot, repoSlug, requireCursorApiKey, type FactoryConfig } from './config.ts';
import { CursorWorker } from './worker.ts';
import { GitHubIssueSource } from './workSource.ts';
import { FactoryState } from './state.ts';
import { Telemetry } from './telemetry.ts';
import { filterClaimed, parseSelection, type Selection } from './selector.ts';
import { groomPrompt, implementPrompt, selectPrompt } from './prompts.ts';
import { groomState, isGroomed, needsGroom, parseGroomReply } from './groom.ts';
import { addPrLabels, commentOnIssue, ensureLabel, findPrByBranch } from './github.ts';

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

export function buildWorker(config: FactoryConfig): CursorWorker {
  return new CursorWorker({
    apiKey: requireCursorApiKey(),
    repoUrl: config.repo.url,
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
  const pending = needsGroom(candidates, opts.force).slice(0, opts.limit ?? ctx.config.groom.maxPerTick);
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
    regroom: groomState(task.body).kind !== 'ungroomed',
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

export async function tick(opts: { dryRun: boolean }): Promise<void> {
  const ctx = buildContext();
  const { config } = ctx;

  // 1. Record human verdicts on previously opened PRs, release their issues.
  const recorded = await ctx.state.reconcileOutcomes(log);
  if (recorded > 0) log(`reconciled ${recorded} human outcome(s)`);

  const candidates = await candidateTasks(ctx);
  if (candidates.length === 0) {
    log('no open unclaimed issues. Nothing to do.');
    return;
  }

  if (opts.dryRun) {
    await dryRun(ctx, candidates);
    return;
  }

  const worker = buildWorker(config);

  // 2. Grooming: vet part of the backlog. Deliberately ahead of the
  //    active-job gate — it produces no code, so it cannot collide.
  await runGroomPhase(ctx, worker, candidates);

  // 3. Single-active-job invariant, for the implementation half only.
  const active = await ctx.state.activeJob(log);
  if (active) {
    if (active.kind === 'pr-awaiting-human') {
      log(`implementation paused: PR awaiting human action → ${active.prUrl} ("${active.title}")`);
    } else {
      log(`implementation paused: pipeline in flight for ${active.current.taskId} (agent ${active.current.agentId}). Use \`factory abort\` if it is dead.`);
    }
    return;
  }

  // 4. Selector agent picks the most well-scoped groomed issue. Re-fetch, since
  //    the groom phase just rewrote some of the bodies we hold.
  const tasks = (await candidateTasks(ctx)).filter(isGroomed);
  if (tasks.length === 0) {
    log('no groomed issues available to implement. Nothing to do.');
    return;
  }

  log(`handing ${tasks.length} groomed issue(s) to the selector agent`);
  const picked = await runSelector(worker, tasks);
  if (picked.selection.kind === 'none') {
    log(`selector picked nothing. Its reasoning:\n${picked.reply}`);
    return;
  }
  if (picked.selection.kind === 'unparseable') {
    throw new Error(`selector reply had no usable pick:\n${picked.reply.slice(0, 500)}`);
  }
  const task = picked.selection.task;
  log(`selector picked #${task.issueNumber} "${task.title}"`);

  // 4. Handoff: a fresh implementer session takes the chosen issue.
  await ensureLabel(repoSlug(config), config.labels.factoryPr, '0E8A16', 'Opened by the software factory');
  await ctx.source.markStarted(task);
  await runPipeline(ctx, worker, task, picked.agentId, picked.usage).catch(async (err) => {
    log(`pipeline error: ${(err as Error).message}`);
    await failRun(ctx, worker, task, (err as Error).message);
  });
}

/** What the tick would do, and the exact prompts it would send. Spends nothing. */
async function dryRun(ctx: FactoryContext, candidates: Task[]): Promise<void> {
  const pending = needsGroom(candidates);
  const groomed = candidates.filter(isGroomed);
  const needsWork = candidates.length - pending.length - groomed.length;
  log(`dry run: ${candidates.length} unclaimed issue(s) — ${groomed.length} groomed, ${needsWork} needs-work, ${pending.length} awaiting grooming`);

  const next = pending.slice(0, ctx.config.groom.maxPerTick);
  if (next.length > 0) {
    log(`would groom: ${next.map((t) => `#${t.issueNumber}`).join(' ')}. Groom prompt for #${next[0]!.issueNumber}:`);
    console.log(`\n${groomPrompt(next[0]!, loadPrinciples(ctx.config))}\n`);
  }
  if (groomed.length > 0) {
    log('selector prompt would be:');
    console.log(`\n${selectPrompt(groomed)}\n`);
  }
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
  state.writeCurrent(current);

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
      await commentOnIssue(repoSlug(config), task.issueNumber,
        `🏭 The factory attempted this issue but did not open a PR. Agent's report:\n\n${result.resultText}`);
    }
    await ctx.source.markFinished(task);
  } else {
    current.prUrl = prUrl;
    state.writeCurrent(current);
    await addPrLabels(repoSlug(config), prUrl, [config.labels.factoryPr]);
    await commentOnIssue(repoSlug(config), task.issueNumber,
      `🏭 The factory opened ${prUrl} for this issue. It is awaiting human review; the factory is paused until it is merged or closed.`);
    log(`done: ${prUrl} awaits human review. Factory pauses until a human merges or closes it.`);
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
  state.clearCurrent();
}

async function failRun(ctx: FactoryContext, worker: CodingWorker, task: Task, reason: string): Promise<void> {
  const current = ctx.state.readCurrent();
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
  // PR was created before the failure, it carries the factory label and keeps
  // the factory paused until a human deals with it.
  await ctx.source.markFinished(task);
  ctx.state.clearCurrent();
}
