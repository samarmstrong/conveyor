#!/usr/bin/env tsx
// factory CLI — the daily trigger runs `factory run`; everything else is
// for humans operating the factory.

import { buildContext, buildWorker, candidateTasks, log, runGroomPhase, runSelector, tick } from './controller.ts';
import { requireCursorApiKey } from './config.ts';
import { isGroomed, needsGroom } from './groom.ts';

const USAGE = `conveyor — thin software-factory control plane around Cursor

Usage:
  npm run factory -- run [--dry-run]   One idempotent tick: groom part of the backlog, then a selector agent picks a groomed issue and a fresh agent implements it.
  npm run factory -- groom [--limit N] [--force]
                                       Run just the grooming phase (vets issues against principles.md; no implementation).
                                       --force re-grooms issues that already have a current verdict — use after editing
                                       principles.md or the groom prompt, which do not invalidate verdicts on their own.
  npm run factory -- select            Run just the selector agent over the groomed issues and show its pick (no implementation, no labels).
  npm run factory -- status            Show grooming progress, active job, pending PRs, and recent telemetry.
  npm run factory -- abort             Abandon a stuck local pipeline (cancels the Cursor run if possible).
`;

async function groom(opts: { limit?: number; force?: boolean }): Promise<void> {
  const ctx = buildContext();
  const candidates = await candidateTasks(ctx);
  const records = await runGroomPhase(ctx, buildWorker(ctx.config), candidates, opts);
  if (records.length === 0) {
    log('nothing to groom.');
    return;
  }
  for (const r of records) {
    log(`  #${r.issueNumber} → ${r.verdict}${r.hadNotes ? ' (+notes)' : ''}${r.regroom ? ' [re-groom]' : ''}`);
  }
  const remaining = needsGroom(candidates, opts.force).length - records.length;
  if (remaining > 0) log(`${remaining} issue(s) still awaiting grooming.`);
}

async function status(): Promise<void> {
  const ctx = buildContext();

  const candidates = await candidateTasks(ctx);
  const pending = needsGroom(candidates).length;
  const groomed = candidates.filter(isGroomed).length;
  log(`backlog: ${candidates.length} unclaimed — ${groomed} groomed, ${candidates.length - pending - groomed} needs-work, ${pending} awaiting grooming`);

  const active = await ctx.state.activeJob(log);
  if (!active) {
    log('no active job.');
  } else if (active.kind === 'pr-awaiting-human') {
    log(`active: PR awaiting human → ${active.prUrl} ("${active.title}")`);
  } else {
    log(`active: pipeline in flight → ${active.current.taskId} agent=${active.current.agentId} started=${active.current.startedAt}`);
  }
  const runs = ctx.telemetry.runs().slice(-5);
  if (runs.length > 0) {
    log('recent runs:');
    for (const r of runs) {
      log(`  ${r.startedAt} #${r.issueNumber} → ${r.outcome}${r.prUrl ? ` ${r.prUrl}` : ''}${r.failureReason ? ` (${r.failureReason})` : ''}`);
    }
  }
  const awaiting = ctx.telemetry.prsAwaitingOutcome();
  for (const r of awaiting) log(`awaiting human outcome: ${r.prUrl}`);
}

async function select(): Promise<void> {
  const ctx = buildContext();
  const tasks = (await candidateTasks(ctx)).filter(isGroomed);
  if (tasks.length === 0) {
    log('no groomed issues. Run `factory groom` first.');
    return;
  }
  log(`handing ${tasks.length} groomed issue(s) to the selector agent`);
  const picked = await runSelector(buildWorker(ctx.config), tasks);
  console.log(`\n${picked.reply}\n`);
  if (picked.selection.kind === 'picked') {
    log(`pick: #${picked.selection.task.issueNumber} "${picked.selection.task.title}"`);
  } else {
    log(`pick: ${picked.selection.kind}`);
  }
}

async function abort(): Promise<void> {
  const ctx = buildContext();
  const current = ctx.state.readCurrent();
  if (!current) {
    log('no local pipeline state to abort.');
    return;
  }
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
  ctx.state.clearCurrent();
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
    case 'status':
      await status();
      break;
    case 'abort':
      await abort();
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
