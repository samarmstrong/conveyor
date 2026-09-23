#!/usr/bin/env tsx
// factory CLI — the daily trigger runs `factory run`; everything else is
// for humans operating the factory.

import { admissible, buildContext, buildWorker, candidateTasks, environmentInputs, log, openSet, runEnvironmentPhase, runGroomPhase, runSelector, runSimplifyPhase, simplifySkip, tick } from './controller.ts';
import { repoSlug } from './config.ts';
import { isEpic, isGroomed, needsGroom, verdict } from './groom.ts';
import { defaultBranchHead } from './github.ts';
import type { CodingWorker, CurrentRun } from './types.ts';

const USAGE = `conveyor — thin software-factory control plane around Cursor cloud agents or local Claude Code

Usage:
  npm run factory -- run [--dry-run]   One idempotent tick: groom part of the backlog, then hand the oldest groomed issue to a fresh implementer agent (a selector agent picks instead if selector.enabled).
  npm run factory -- groom [--limit N] [--force]
                                       Run just the grooming phase (vets issues against principles.md; no implementation).
                                       --force re-grooms issues that already have a current verdict — use after editing
                                       principles.md or the groom prompt, which do not invalidate verdicts on their own.
  npm run factory -- select            Run just the selector agent over the groomed issues and show its pick (no implementation, no labels). Works even with selector.enabled off.
  npm run factory -- env               Run just the environment phase: an agent reads the factory PRs it has not read yet,
                                       looking for checks the implementer could not run, and fixes .cursor/environment.json
                                       in the target repo so the next one can. Opens a PR only if it finds a gap it can close.
  npm run factory -- simplify          Run just the simplification phase: an agent reads the codebase, starting from the
                                       factory's own merged PRs, and opens one PR that removes more code than it adds.
                                       A PR that grows the code is closed by the factory before a human sees it.
  npm run factory -- status            Show grooming progress, capacity, in-flight jobs, pending PRs, and recent telemetry.
  npm run factory -- abort [--issue N] Abandon stuck local pipelines — all of them, or just issue N's
                                       (cancels the runs if the worker still can).

Environment: FACTORY_WORKER=cursor|claude-code overrides worker.kind for one invocation.
`;

async function groom(opts: { limit?: number; force?: boolean }): Promise<void> {
  const ctx = buildContext();
  const all = await candidateTasks(ctx);
  const open = await openSet(ctx, all);
  const candidates = admissible(ctx, all, 'groom');
  const records = await runGroomPhase(ctx, await buildWorker(ctx.config), candidates, { ...opts, open });
  if (records.length === 0) {
    log('nothing to groom.');
    return;
  }
  for (const r of records) {
    const extras = [
      r.epic ? `epic, ${r.childrenFiled ?? 0} child(ren) filed` : '',
      r.hadNotes ? '+notes' : '',
      r.blockedOn !== undefined ? `blocked on #${r.blockedOn}` : '',
      r.regroom ? 're-groom' : '',
    ].filter(Boolean);
    log(`  #${r.issueNumber} → ${r.verdict}${extras.length ? ` (${extras.join('; ')})` : ''}`);
  }
  const remaining = needsGroom(candidates, ctx.config.labels, opts.force, open).length - records.length;
  if (remaining > 0) log(`${remaining} issue(s) still awaiting grooming.`);
}

async function status(): Promise<void> {
  const ctx = buildContext();

  const allCandidates = await candidateTasks(ctx);
  const candidates = admissible(ctx, allCandidates, 'groom');
  const { labels } = ctx.config;
  const groomed = candidates.filter((t) => isGroomed(t, labels)).length;
  const needsWork = candidates.filter((t) => verdict(t, labels) === 'needs-work').length;
  const epics = candidates.filter((t) => isEpic(t, labels)).length;
  // The buckets overlap: a groomed issue someone has since replied to is both
  // implementable and queued for another look.
  const pending = needsGroom(candidates, labels, false, await openSet(ctx, allCandidates)).length;
  log(`backlog: ${candidates.length} unclaimed — ${groomed} groomed, ${needsWork} needs-work, ${candidates.length - groomed - needsWork} never groomed, ${epics} epic(s) among them (${pending} queued for a groom)`);

  const implementable = admissible(ctx, allCandidates, 'implement').filter((t) => isGroomed(t, labels)).length;
  const assigned = allCandidates.filter((t) => t.assignees.length > 0);
  if (assigned.length > 0) {
    const held = [
      ...(ctx.config.assignedIssues.groom ? [] : ['grooming']),
      ...(ctx.config.assignedIssues.implement ? [] : ['implementation']),
    ];
    log(`assigned to a human: ${assigned.length} issue(s)${held.length ? ` — withheld from ${held.join(' and ')}` : ' — not withheld from anything'}`);
  }
  log(`implementable now: ${implementable} groomed issue(s) ready for an implementer`);

  const capacity = await ctx.state.capacity(log);
  log(`capacity: ${capacity.slots} of ${capacity.limit} slot(s) free`);
  for (const pr of capacity.openPrs) log(`  awaiting human: ${pr.url} ("${pr.title}")`);
  for (const run of capacity.inFlight) {
    log(`  in flight: ${run.taskId} agent=${run.agentId} started=${run.startedAt}`);
  }
  if (capacity.openPrs.length === 0 && capacity.inFlight.length === 0) log('  no active jobs.');
  const runs = ctx.telemetry.runs().slice(-5);
  if (runs.length > 0) {
    log('recent runs:');
    for (const r of runs) {
      log(`  ${r.startedAt} #${r.issueNumber} → ${r.outcome}${r.prUrl ? ` ${r.prUrl}` : ''}${r.failureReason ? ` (${r.failureReason})` : ''}`);
    }
  }
  // The environment queue is separate from `maxConcurrentJobs` on purpose, so
  // it needs saying separately.
  const { environment } = ctx.config;
  if (!environment.enabled) {
    log('environment: disabled.');
  } else {
    const { skip, unread, changedAt } = await environmentInputs(ctx.config);
    log(`environment: ${skip ?? `${unread.fresh.length} factory PR(s) unread; next pass reads ${Math.min(unread.fresh.length, environment.maxPrsPerPass)}`}.`);
    if (changedAt) log(`  environment last changed ${changedAt}${unread.stale.length ? `; ${unread.stale.length} older report(s) void` : ''}`);
    const last = ctx.telemetry.envPasses().at(-1);
    if (last) log(`  last pass: ${last.startedAt} → ${last.outcome}${last.prUrl ? ` ${last.prUrl}` : ''} (read ${last.prsExamined.length} PR(s))`);
  }

  const { sha } = await defaultBranchHead(repoSlug(ctx.config));
  const simplifySkipped = await simplifySkip(ctx, sha);
  log(`simplify: ${simplifySkipped ?? `next tick looks for one simplification at ${sha.slice(0, 8)}`}.`);
  const lastSimplify = ctx.telemetry.simplifyPasses().at(-1);
  if (lastSimplify) {
    const lines = lastSimplify.additions !== undefined ? ` (−${lastSimplify.deletions} +${lastSimplify.additions})` : '';
    log(`  last pass: ${lastSimplify.startedAt} → ${lastSimplify.outcome}${lastSimplify.prUrl ? ` ${lastSimplify.prUrl}` : ''}${lines}`);
  }
}

async function simplify(): Promise<void> {
  const ctx = buildContext();
  const record = await runSimplifyPhase(ctx, await buildWorker(ctx.config));
  if (!record) return;
  const lines = record.additions !== undefined ? ` (−${record.deletions} +${record.additions})` : '';
  log(`simplification pass → ${record.outcome}${record.prUrl ? ` ${record.prUrl}` : ''}${lines}${record.failureReason ? ` (${record.failureReason})` : ''}`);
}

async function env(): Promise<void> {
  const ctx = buildContext();
  const record = await runEnvironmentPhase(ctx, await buildWorker(ctx.config));
  if (!record) return;
  log(`environment pass → ${record.outcome}${record.prUrl ? ` ${record.prUrl}` : ''}${record.failureReason ? ` (${record.failureReason})` : ''}`);
}

async function select(): Promise<void> {
  const ctx = buildContext();
  const tasks = admissible(ctx, await candidateTasks(ctx), 'implement').filter((t) => isGroomed(t, ctx.config.labels));
  if (tasks.length === 0) {
    log('no groomed issues. Run `factory groom` first.');
    return;
  }
  log(`handing ${tasks.length} groomed issue(s) to the selector agent`);
  const picked = await runSelector(await buildWorker(ctx.config), tasks);
  console.log(`\n${picked.reply}\n`);
  if (picked.selection.kind === 'picked') {
    log(`pick: #${picked.selection.task.issueNumber} "${picked.selection.task.title}"`);
  } else {
    log(`pick: ${picked.selection.kind}`);
  }
}

async function abort(opts: { issueNumber?: number }): Promise<void> {
  const ctx = buildContext();
  const runs = ctx.state.readRuns().filter(
    (r) => opts.issueNumber === undefined || r.issueNumber === opts.issueNumber,
  );
  if (runs.length === 0) {
    log(
      opts.issueNumber === undefined
        ? 'no local pipeline state to abort.'
        : `no local pipeline for #${opts.issueNumber}.`,
    );
    return;
  }
  const worker = await buildWorker(ctx.config).catch((err: Error) => {
    log(`could not build the worker to cancel runs (${err.message}); clearing local state only.`);
    return null;
  });
  for (const current of runs) await abortRun(ctx, worker, current);
}

async function abortRun(ctx: ReturnType<typeof buildContext>, worker: CodingWorker | null, current: CurrentRun): Promise<void> {
  if (worker) {
    await worker.cancel({ agentId: current.agentId, runId: current.runId });
    log(`cancel requested for agent ${current.agentId} run ${current.runId}`);
  }
  ctx.telemetry.append({
    type: 'run',
    taskId: current.taskId,
    issueNumber: current.issueNumber,
    issueTitle: '',
    worker: ctx.config.worker.kind,
    model: ctx.config.worker.model,
    agentId: current.agentId,
    startedAt: current.startedAt,
    finishedAt: new Date().toISOString(),
    outcome: 'aborted',
    failureReason: 'manually aborted via `factory abort`',
    prUrl: current.prUrl,
    usage: null,
    durationMs: Date.now() - Date.parse(current.startedAt),
  });
  const { removeIssueLabels } = await import('./github.ts');
  const { repoSlug } = await import('./config.ts');
  await removeIssueLabels(repoSlug(ctx.config), current.issueNumber, [ctx.config.labels.issueInProgress]).catch(() => {});
  ctx.state.clearRun(current.taskId);
  log(`aborted pipeline for ${current.taskId}.`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args.find((a) => !a.startsWith('--')) ?? 'run';
  const dryRun = args.includes('--dry-run');
  const limitArg = args.find((a) => a.startsWith('--limit'))?.split('=')[1]
    ?? (args.includes('--limit') ? args[args.indexOf('--limit') + 1] : undefined);
  const limit = limitArg !== undefined ? Number(limitArg) : undefined;
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    throw new Error(`--limit must be a positive integer, got "${limitArg}"`);
  }
  const issueArg = args.find((a) => a.startsWith('--issue'))?.split('=')[1]
    ?? (args.includes('--issue') ? args[args.indexOf('--issue') + 1] : undefined);
  const issueNumber = issueArg !== undefined ? Number(issueArg) : undefined;
  if (issueNumber !== undefined && (!Number.isInteger(issueNumber) || issueNumber < 1)) {
    throw new Error(`--issue must be a positive integer, got "${issueArg}"`);
  }

  switch (command) {
    case 'run':
      await tick({ dryRun });
      break;
    case 'groom':
      await groom({ ...(limit !== undefined ? { limit } : {}), force: args.includes('--force') });
      break;
    case 'select':
      await select();
      break;
    case 'env':
      await env();
      break;
    case 'simplify':
      await simplify();
      break;
    case 'status':
      await status();
      break;
    case 'abort':
      await abort({ ...(issueNumber !== undefined ? { issueNumber } : {}) });
      break;
    default:
      console.log(USAGE);
      process.exitCode = command === 'help' ? 0 : 1;
  }
}

main().catch((err) => {
  console.error(`fatal: ${(err as Error).message}`);
  process.exitCode = 1;
});
