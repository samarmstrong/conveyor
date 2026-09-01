// FactoryState: the "how much work is already in flight?" question.
// Source of truth is GitHub (open PRs carrying the factory label); a small
// local current-runs file adds crash detection for pipelines mid-flight.
// Both count against the one throttle, config.maxConcurrentJobs.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { CurrentRun, OutcomeRecord } from './types.ts';
import type { FactoryConfig } from './config.ts';
import { repoSlug } from './config.ts';
import { linkedIssueNumber, listPrsByLabel, removeIssueLabels, viewPr } from './github.ts';
import type { Telemetry } from './telemetry.ts';

export interface Capacity {
  /** config.maxConcurrentJobs: how many jobs may exist at once. */
  limit: number;
  /** Factory PRs awaiting a human. */
  openPrs: { url: string; title: string }[];
  /** Pipelines still running (stale ones already cleaned up). */
  inFlight: CurrentRun[];
  /** How many new pipelines this tick may start. */
  slots: number;
}

export class FactoryState {
  private readonly runsFile: string;

  constructor(
    private readonly config: FactoryConfig,
    private readonly telemetry: Telemetry,
    stateDir: string,
  ) {
    mkdirSync(stateDir, { recursive: true });
    this.runsFile = resolve(stateDir, 'current-runs.json');
    this.migrateLegacyRunFile(resolve(stateDir, 'current-run.json'));
  }

  /** Before concurrency there was one pipeline and one current-run.json. Fold a
   *  pipeline that was in flight across the upgrade into the array file. */
  private migrateLegacyRunFile(legacyFile: string): void {
    if (!existsSync(legacyFile)) return;
    const legacy = JSON.parse(readFileSync(legacyFile, 'utf8')) as CurrentRun;
    this.writeRun(legacy);
    rmSync(legacyFile, { force: true });
  }

  private get repo(): string {
    return repoSlug(this.config);
  }

  readRuns(): CurrentRun[] {
    if (!existsSync(this.runsFile)) return [];
    return JSON.parse(readFileSync(this.runsFile, 'utf8')) as CurrentRun[];
  }

  readRun(taskId: string): CurrentRun | null {
    return this.readRuns().find((r) => r.taskId === taskId) ?? null;
  }

  /** Upsert by taskId: one record per pipeline, rewritten as it learns its PR. */
  writeRun(run: CurrentRun): void {
    this.writeRuns([...this.readRuns().filter((r) => r.taskId !== run.taskId), run]);
  }

  clearRun(taskId: string): void {
    this.writeRuns(this.readRuns().filter((r) => r.taskId !== taskId));
  }

  private writeRuns(runs: CurrentRun[]): void {
    if (runs.length === 0) {
      rmSync(this.runsFile, { force: true });
      return;
    }
    writeFileSync(this.runsFile, JSON.stringify(runs, null, 2));
  }

  /**
   * Record human outcomes for any factory PR that has been merged or closed
   * since the last tick, and release the claimed issues. Returns the number
   * of outcomes recorded.
   */
  async reconcileOutcomes(log: (msg: string) => void): Promise<number> {
    const awaiting = this.telemetry.prsAwaitingOutcome();
    let recorded = 0;
    for (const job of awaiting) {
      const pr = await viewPr(this.repo, job.prUrl).catch(() => null);
      if (!pr || pr.state === 'OPEN') continue;

      const changeRequests = pr.reviews.filter((r) => r.state === 'CHANGES_REQUESTED').length;
      const issueNumber = job.issueNumber ?? (job.source === 'environment' ? null : linkedIssueNumber(pr.body));
      const outcome: OutcomeRecord = {
        type: 'outcome',
        prUrl: job.prUrl,
        ...(job.source ? { source: job.source } : {}),
        issueNumber,
        merged: pr.state === 'MERGED',
        closedAt: pr.mergedAt ?? pr.closedAt ?? new Date().toISOString(),
        humanChangeRequests: changeRequests,
        humanCommentCount: pr.comments.length,
        recordedAt: new Date().toISOString(),
      };
      this.telemetry.append(outcome);
      recorded += 1;
      log(`outcome recorded: ${job.prUrl} → ${pr.state}`);

      // Environment PRs claim no issue, so there is no wip label to release.
      if (issueNumber !== null) {
        await removeIssueLabels(this.repo, issueNumber, [this.config.labels.issueInProgress]).catch(() => {});
      }
    }
    return recorded;
  }

  /**
   * The throttle, in one number. A job is an open factory PR awaiting a human
   * or a pipeline still running; at most `maxConcurrentJobs` exist at once, and
   * so a tick starts at most that many. `maxConcurrentJobs: 1` is the strict
   * one-at-a-time factory.
   *
   * Stale run records (crashed pipelines, older than `staleRunHours`) are
   * recorded as aborted and cleaned up here, so a crash cannot leak capacity.
   */
  async capacity(log: (msg: string) => void): Promise<Capacity> {
    const limit = this.config.maxConcurrentJobs;
    const openPrs = (await listPrsByLabel(this.repo, this.config.labels.factoryPr, 'open')).map((pr) => ({
      url: pr.url,
      title: pr.title,
    }));

    const inFlight: CurrentRun[] = [];
    for (const run of this.readRuns()) {
      const ageHours = (Date.now() - Date.parse(run.startedAt)) / 3_600_000;
      if (ageHours < this.config.staleRunHours) {
        inFlight.push(run);
        continue;
      }
      log(`stale pipeline (${ageHours.toFixed(1)}h old) for ${run.taskId}; recording as failed and cleaning up`);
      this.telemetry.append({
        type: 'run',
        taskId: run.taskId,
        issueNumber: run.issueNumber,
        issueTitle: '',
        worker: 'cursor',
        model: this.config.worker.model,
        agentId: run.agentId,
        startedAt: run.startedAt,
        finishedAt: new Date().toISOString(),
        outcome: 'aborted',
        failureReason: `stale pipeline older than ${this.config.staleRunHours}h (controller crash?)`,
        prUrl: run.prUrl,
        usage: null,
        durationMs: Date.now() - Date.parse(run.startedAt),
      });
      await removeIssueLabels(this.repo, run.issueNumber, [this.config.labels.issueInProgress]).catch(() => {});
      this.clearRun(run.taskId);
    }

    // A pipeline that already opened its PR appears in both lists; count it once.
    const openPrUrls = new Set(openPrs.map((pr) => pr.url));
    const unpaired = inFlight.filter((r) => r.prUrl === null || !openPrUrls.has(r.prUrl));

    return {
      limit,
      openPrs,
      inFlight,
      slots: Math.max(0, limit - openPrs.length - unpaired.length),
    };
  }
}
