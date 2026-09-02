#!/usr/bin/env tsx
// factory CLI — the daily trigger runs `factory run`; everything else is
// for humans operating the factory.

import { admissible, buildContext, buildWorker, candidateTasks, log, runEnvironmentPhase, runGroomPhase, runSelector, tick } from './controller.ts';
import { repoSlug, requireCursorApiKey } from './config.ts';
import { isGroomed, needsGroom, verdict } from './groom.ts';
import { environmentChangedAt, skipReason, unreadFactoryPrs } from './environment.ts';
import { listPrsByLabel } from './github.ts';
import type { CurrentRun } from './types.ts';

const USAGE = `conveyor — thin software-factory control plane around Cursor

Usage:
  npm run factory -- run [--dry-run]   One idempotent tick: groom part of the backlog, then a selector agent picks a groomed issue and a fresh agent implements it.
  npm run factory -- groom [--limit N] [--force]
                                       Run just the grooming phase (vets issues against principles.md; no implementation).
                                       --force re-grooms issues that already have a current verdict — use after editing
                                       principles.md or the groom prompt, which do not invalidate verdicts on their own.
  npm run factory -- select            Run just the selector agent over the groomed issues and show its pick (no implementation, no labels).
  npm run factory -- env               Run just the environment phase: an agent reads the factory PRs it has not read yet,
                                       looking for checks the implementer could not run, and fixes .cursor/environment.json
                                       in the target repo so the next one can. Opens a PR only if it finds a gap it can close.
  npm run factory -- status            Show grooming progress, capacity, in-flight jobs, pending PRs, and recent telemetry.
  npm run factory -- abort [--issue N] Abandon stuck local pipelines — all of them, or just issue N's
                                       (cancels the Cursor runs if possible).
`;

async function groom(opts: { limit?: number; force?: boolean }): Promise<void> {
  const ctx = buildContext();
  const candidates = admissible(ctx, await candidateTasks(ctx), 'groom');
  const records = await runGroomPhase(ctx, await buildWorker(ctx.config), candidates, opts);
  if (records.length === 0) {
    log('nothing to groom.');
    return;
  }
  for (const r of records) {
    log(`  #${r.issueNumber} → ${r.verdict}${r.hadNotes ? ' (+notes)' : ''}${r.regroom ? ' [re-groom]' : ''}`);
  }
  const remaining = needsGroom(candidates, ctx.config.labels, opts.force).length - records.length;
  if (remaining > 0) log(`${remaining} issue(s) still awaiting grooming.`);
}

async function status(): Promise<void> {
  const ctx = buildContext();

  const allCandidates = await candidateTasks(ctx);
  const candidates = admissible(ctx, allCandidates, 'groom');
  const { labels } = ctx.config;
  const groomed = candidates.filter((t) => isGroomed(t, labels)).length;
  const needsWork = candidates.filter((t) => verdict(t, labels) === 'needs-work').length;
  // The buckets overlap: a groomed issue someone has since replied to is both
  // implementable and queued for another look.
  const pending = needsGroom(candidates, labels).length;
  log(`backlog: ${candidates.length} unclaimed — ${groomed} groomed, ${needsWork} needs-work, ${candidates.length - groomed - needsWork} never groomed (${pending} queued for a groom)`);

  const implementable = admissible(ctx, allCandidates, 'implement').filter((t) => isGroomed(t, labels)).length;
  const assigned = allCandidates.filter((t) => t.assignees.length > 0);
  if (assigned.length > 0) {
    const held = [
      ...(ctx.config.assignedIssues.groom ? [] : ['grooming']),
      ...(ctx.config.assignedIssues.implement ? [] : ['implementation']),
    ];
    log(`assigned to a human: ${assigned.length} issue(s)${held.length ? ` — withheld from ${held.join(' and ')}` : ' — not withheld from anything'}`);
  }
  log(`implementable now: ${implementable} groomed issue(s) the selector may draw from`);

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
  const awaiting = ctx.telemetry.prsAwaitingOutcome();
  for (const r of awaiting) log(`awaiting human outcome: ${r.prUrl}${r.source === 'environment' ? ' (environment)' : ''}`);

  // The environment queue is separate from `maxConcurrentJobs` on purpose, so
  // it needs saying separately.
  const { environment } = ctx.config;
  if (!environment.enabled) {
    log('environment: disabled.');
  } else {
    const openEnvPrs = await listPrsByLabel(repoSlug(ctx.config), labels.environmentPr, 'open');
    const changedAt = environmentChangedAt(ctx.telemetry.outcomes());
    const unread = unreadFactoryPrs(ctx.telemetry.runs(), ctx.telemetry.envPasses(), changedAt);
    const skip = skipReason(true, openEnvPrs, unread, changedAt);
    log(`environment: ${skip ?? `${unread.fresh.length} factory PR(s) unread; next pass reads ${Math.min(unread.fresh.length, environment.maxPrsPerPass)}`}.`);
    if (changedAt) log(`  environment last changed ${changedAt}${unread.stale.length ? `; ${unread.stale.length} older report(s) void` : ''}`);
    const last = ctx.telemetry.envPasses().at(-1);
    if (last) log(`  last pass: ${last.startedAt} → ${last.outcome}${last.prUrl ? ` ${last.prUrl}` : ''} (read ${last.prsExamined.length} PR(s))`);
  }
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
  for (const current of runs) await abortRun(ctx, current);
}

async function abortRun(ctx: ReturnType<typeof buildContext>, current: CurrentRun): Promise<void> {
  try {
    const apiKey = requireCursorApiKey();
    const res = await fetch(
      `https://api.cursor.com/v1/agents/${current.agentId}/runs/${current.runId}/cancel`,
      { method: 'POST', headers: { Authorization: `Bearer ${apiKey}` } },
    );
    log(`cancel request for agent ${current.agentId} run ${current.runId}: HTTP ${res.status}`);
  } catch (err) {
    log(`could not cancel the Cursor run (${(err as Error).message}); stop it from the Cursor dashboard if needed.`);
  }
  ctx.telemetry.append({
    type: 'run',
    taskId: current.taskId,
    issueNumber: current.issueNumber,
    issueTitle: '',
    worker: 'cursor',
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
