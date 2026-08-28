// FactoryState: the "is there already work in flight?" question.
// Source of truth is GitHub (open PRs carrying the factory label); a small
// local current-run file adds crash detection for a pipeline mid-flight.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { CurrentRun, OutcomeRecord } from './types.ts';
import type { FactoryConfig } from './config.ts';
import { repoSlug } from './config.ts';
import { linkedIssueNumber, listPrsByLabel, removeIssueLabels, viewPr } from './github.ts';
import type { Telemetry } from './telemetry.ts';

export type ActiveJob =
  | { kind: 'pr-awaiting-human'; prUrl: string; title: string }
  | { kind: 'pipeline-in-flight'; current: CurrentRun }
  | null;

export class FactoryState {
  private readonly currentFile: string;

  constructor(
    private readonly config: FactoryConfig,
    private readonly telemetry: Telemetry,
    stateDir: string,
  ) {
    mkdirSync(stateDir, { recursive: true });
    this.currentFile = resolve(stateDir, 'current-run.json');
  }

  private get repo(): string {
    return repoSlug(this.config);
  }

  readCurrent(): CurrentRun | null {
    if (!existsSync(this.currentFile)) return null;
    return JSON.parse(readFileSync(this.currentFile, 'utf8')) as CurrentRun;
  }

  writeCurrent(current: CurrentRun): void {
    writeFileSync(this.currentFile, JSON.stringify(current, null, 2));
  }

  clearCurrent(): void {
    rmSync(this.currentFile, { force: true });
  }

  /**
   * Record human outcomes for any factory PR that has been merged or closed
   * since the last tick, and release the claimed issues. Returns the number
   * of outcomes recorded.
   */
  async reconcileOutcomes(log: (msg: string) => void): Promise<number> {
    const awaiting = this.telemetry.prsAwaitingOutcome();
    let recorded = 0;
    for (const run of awaiting) {
      if (!run.prUrl) continue;
      const pr = await viewPr(this.repo, run.prUrl).catch(() => null);
      if (!pr || pr.state === 'OPEN') continue;

      const changeRequests = pr.reviews.filter((r) => r.state === 'CHANGES_REQUESTED').length;
      const outcome: OutcomeRecord = {
        type: 'outcome',
        prUrl: run.prUrl,
        issueNumber: run.issueNumber ?? linkedIssueNumber(pr.body),
        merged: pr.state === 'MERGED',
        closedAt: pr.mergedAt ?? pr.closedAt ?? new Date().toISOString(),
        humanChangeRequests: changeRequests,
        humanCommentCount: pr.comments.length,
        recordedAt: new Date().toISOString(),
      };
      this.telemetry.append(outcome);
      recorded += 1;
      log(`outcome recorded: ${run.prUrl} → ${pr.state}`);

      await removeIssueLabels(this.repo, run.issueNumber, [this.config.labels.issueInProgress]).catch(() => {});
    }
    return recorded;
  }

  /**
   * The single-active-job invariant. A job is active if (a) an open PR carries
   * the factory label, or (b) a fresh current-run file says a pipeline is in
   * flight. A stale current-run file (crashed pipeline) is cleaned up and
   * recorded as a failure.
   */
  async activeJob(log: (msg: string) => void): Promise<ActiveJob> {
    const openPrs = await listPrsByLabel(this.repo, this.config.labels.factoryPr, 'open');
    const firstOpen = openPrs[0];
    if (firstOpen) {
      return { kind: 'pr-awaiting-human', prUrl: firstOpen.url, title: firstOpen.title };
    }

    const current = this.readCurrent();
    if (current) {
      const ageHours = (Date.now() - Date.parse(current.startedAt)) / 3_600_000;
      if (ageHours < this.config.staleRunHours) {
        return { kind: 'pipeline-in-flight', current };
      }
      log(`stale pipeline (${ageHours.toFixed(1)}h old) for ${current.taskId}; recording as failed and cleaning up`);
      this.telemetry.append({
        type: 'run',
        taskId: current.taskId,
        issueNumber: current.issueNumber,
        issueTitle: '',
        worker: 'cursor',
        model: this.config.worker.model,
        agentId: current.agentId,
        startedAt: current.startedAt,
        finishedAt: new Date().toISOString(),
        outcome: 'aborted',
        failureReason: `stale pipeline older than ${this.config.staleRunHours}h (controller crash?)`,
        prUrl: current.prUrl,
        usage: null,
        durationMs: Date.now() - Date.parse(current.startedAt),
      });
      await removeIssueLabels(this.repo, current.issueNumber, [this.config.labels.issueInProgress]).catch(() => {});
      this.clearCurrent();
    }
    return null;
  }
}
