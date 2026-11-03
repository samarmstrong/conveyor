// FactoryState: the "how much work is already in flight?" question, and its
// mirror, "what has finished since we last looked?". Source of truth for both
// is GitHub — PRs carrying the factory labels, issues carrying the in-progress
// label; a small local current-runs file adds crash detection for pipelines
// mid-flight. Open PRs and in-flight pipelines count against the one throttle,
// config.maxConcurrentJobs.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { CurrentRun } from './types.ts';
import type { FactoryConfig } from './config.ts';
import { repoSlug } from './config.ts';
import { addIssueLabels, addPrLabels, closePr, commentOnIssue, commentOnPr, ensureLabel, ghLogin, labelHistory, linkedIssueNumber, listIssuesByLabel, listOpenPrs, listPrsByLabel, markPrReady, prMergeable, referenceState, removeIssueLabels, type PrData } from './github.ts';
import { factoryComment } from './groom.ts';
import { leakedClaims, orphanedPrs, pastGrace, phaseOrphans, spentVerdicts, unclaimedAnswers, unheldClaims, unrecordedOutcomes, withSource, type OrphanPhase } from './outcomes.ts';
import { keysIn, securityStamp } from './security.ts';
import type { Telemetry } from './telemetry.ts';

/** Whether a process with this pid exists on this machine. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists, it is just not ours to signal.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * The PRs this runner opened, out of every PR carrying a factory label. Other
 * people run their own factories on the same repo under the same labels; their
 * PRs wait on them, not on us. From Oct 23 two other runners' open PRs held
 * every slot here for three days. Unknown who we are, every PR counts.
 */
export async function ownPrs<T extends { author: { login: string }; url: string }>(prs: T[], log: (msg: string) => void): Promise<T[]> {
  const me = await ghLogin().catch((err: Error) => {
    log(`could not tell which PRs are this runner's (${err.message}); counting every one`);
    return null;
  });
  if (me === null) return prs;
  const own = prs.filter((pr) => pr.author.login === me);
  const others = prs.filter((pr) => pr.author.login !== me);
  if (others.length > 0) log(`not ours, so not counted: ${others.map((pr) => `${pr.url} (${pr.author.login})`).join(' ')}`);
  return own;
}

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
   * Reconcile with GitHub: record the verdict on every factory PR that has
   * closed and is not yet in the record, release the in-progress label on
   * every issue nothing is working on any more, and take the groomed label off
   * every issue a merged factory PR left open. Returns the number of outcomes
   * recorded. See outcomes.ts for why the decision and the record are separate.
   */
  async reconcileOutcomes(log: (msg: string) => void): Promise<number> {
    const { labels } = this.config;
    const unadopted = await this.adoptOrphans(log);
    const [implementer, environment, simplify, security, claimed] = await Promise.all([
      listPrsByLabel(this.repo, labels.factoryPr, 'all'),
      listPrsByLabel(this.repo, labels.environmentPr, 'all'),
      listPrsByLabel(this.repo, labels.simplifyPr, 'all'),
      listPrsByLabel(this.repo, labels.securityPr, 'all'),
      listIssuesByLabel(this.repo, labels.issueInProgress),
    ]);
    const prs = [
      ...withSource(implementer, 'implementer'),
      ...withSource(environment, 'environment'),
      ...withSource(simplify, 'simplify'),
      ...withSource(security, 'security'),
    ];

    const recorded = new Set(this.telemetry.outcomes().map((o) => o.prUrl));
    const rows = unrecordedOutcomes(prs, recorded);
    for (const row of rows) {
      this.telemetry.append(row);
      log(`outcome recorded: ${row.prUrl} → ${row.merged ? 'MERGED' : 'CLOSED'}`);
    }

    // A draft waits on nobody. The pipeline readies its PR as it labels it,
    // but that call can fail, and Cursor opens drafts at random.
    for (const pr of prs.filter((p) => p.state === 'OPEN' && p.isDraft)) {
      await markPrReady(this.repo, pr.url)
        .then(() => log(`marked ${pr.url} ready for review: it was still a draft`))
        .catch((err: Error) => log(`could not mark ${pr.url} ready for review: ${err.message}`));
    }

    // An orphan too young to adopt may be a live pipeline's PR, and holds its issue as one.
    const openPrs = [...implementer.filter((pr) => pr.state === 'OPEN'), ...unadopted];
    const closedPrs = implementer.filter((pr) => pr.state !== 'OPEN');
    const unheld = unheldClaims(claimed, openPrs, this.readRuns());
    const merged = closedPrs.filter((pr) => pr.state === 'MERGED').map((pr) => linkedIssueNumber(pr.body)).filter((n): n is number => n !== null);
    const history = unheld.length + merged.length ? await labelHistory(this.repo, [...unheld, ...merged]) : new Map();
    const leaked = leakedClaims(unheld, history, closedPrs, labels.issueInProgress, this.config.staleRunHours * 3_600_000);
    for (const issue of leaked) {
      log(`releasing #${issue}: no open factory PR or running pipeline here claims it, and its claim is settled or older than ${this.config.staleRunHours}h`);
      await removeIssueLabels(this.repo, issue, [labels.issueInProgress]).catch(() => {});
    }
    const held = unheld.filter((n) => !leaked.includes(n));
    if (held.length) log(`holding ${held.map((n) => `#${n}`).join(' ')}: claimed with no PR yet, perhaps by a pipeline on another runner; released at ${this.config.staleRunHours}h`);
    for (const issue of unclaimedAnswers(openPrs, claimed)) {
      if ((await referenceState(this.repo, issue)) !== 'open') continue;
      await addIssueLabels(this.repo, issue, [labels.issueInProgress])
        .then(() => log(`claimed #${issue}: an open factory PR answers it, so it is not built again`))
        .catch((err: Error) => log(`could not claim #${issue}: ${err.message}`));
    }

    for (const { issue, prUrl } of spentVerdicts(closedPrs, history, labels)) {
      try {
        await removeIssueLabels(this.repo, issue, [labels.groomed]);
        await commentOnIssue(this.repo, issue, factoryComment(
          `🏭 ${prUrl} merged and this issue is still open, so the groom verdict it was built on is spent. The factory grooms what remains on a later tick.`));
        log(`#${issue} is still open after ${prUrl} merged: its groom verdict is spent, and it is groomed again`);
      } catch (err) {
        log(`could not retire the groom verdict on #${issue}: ${(err as Error).message}`);
      }
    }
    return rows.length;
  }

  /**
   * Take back the PRs a dead pipeline opened and never labelled (see
   * `orphanedPrs`), before anything is picked, so their issues are not built
   * again. One whose issue another factory PR already answers, or that closed
   * since, is a duplicate and is closed. The rest are labelled, readied, and
   * their issues claimed, as the pipeline would have done; nobody watched their
   * CI, and the issue comment says so.
   *
   * Only a PR older than the run budget, plus half an hour, is taken for an
   * orphan (see `pastGrace`). Returns the implementer PRs left alone for being
   * younger, whose issues they hold.
   */
  private async adoptOrphans(log: (msg: string) => void): Promise<PrData[]> {
    const { labels } = this.config;
    const factoryLabels = [labels.factoryPr, labels.environmentPr, labels.simplifyPr, labels.reviewPr, labels.depsPr, labels.securityPr];
    const graceMs = (this.config.worker.maxRunMinutes + 30) * 60_000;
    const all = await listOpenPrs(this.repo);
    const open = all.filter((pr) => pr.labels.some((l) => factoryLabels.includes(l.name)) || pastGrace(pr, graceMs));
    const answered = new Map<number, string>();
    for (const pr of open) {
      const issue = pr.labels.some((l) => l.name === labels.factoryPr) ? linkedIssueNumber(pr.body) : null;
      if (issue !== null) answered.set(issue, pr.url);
    }
    for (const { pr, issue } of orphanedPrs(open, factoryLabels)) {
      try {
        const other = answered.get(issue);
        if (other || (await referenceState(this.repo, issue)) === 'closed') {
          const why = other ? `${other} already answers #${issue}` : `#${issue} has closed`;
          await closePr(this.repo, pr.url, factoryComment(`🏭 Closing: the factory pipeline that opened this died before it took it up, and ${why}.`));
          log(`closed orphaned ${pr.url}: ${why}`);
          continue;
        }
        await markPrReady(this.repo, pr.url);
        await addPrLabels(this.repo, pr.url, [labels.factoryPr]);
        await addIssueLabels(this.repo, issue, [labels.issueInProgress]);
        await commentOnIssue(this.repo, issue, factoryComment(
          `🏭 The factory opened ${pr.url} for this issue. The pipeline that started it died before it took the PR up, so nobody watched its CI or handed a red check back; it is awaiting human review as it stands.`));
        answered.set(issue, pr.url);
        log(`adopted orphaned ${pr.url} for #${issue}: its pipeline died before labelling it`);
      } catch (err) {
        log(`could not adopt orphaned ${pr.url}: ${(err as Error).message}`);
      }
    }
    await this.adoptPhaseOrphans(open, factoryLabels, log);
    return orphanedPrs(all.filter((pr) => !open.includes(pr)), factoryLabels).map((o) => o.pr);
  }

  /**
   * The other phases' orphans (see `phaseOrphans`). A review's is closed: its
   * review left no stamp, so the PR it was replacing is reviewed again. One
   * that conflicts is closed too — its phase works from what is open now, and
   * a security PR closed without a stamp claims no alert, so they are offered
   * again. The rest are labelled and readied as their pipeline would have
   * done, and the babysitter merges them like any factory PR. A security PR's
   * claim is taken from the alerts its own description names.
   */
  private async adoptPhaseOrphans(open: Awaited<ReturnType<typeof listOpenPrs>>, factoryLabels: string[], log: (msg: string) => void): Promise<void> {
    const { labels } = this.config;
    const label: Record<Exclude<OrphanPhase, 'review'>, string> = {
      security: labels.securityPr, env: labels.environmentPr, simplify: labels.simplifyPr, deps: labels.depsPr,
    };
    for (const { pr, phase } of phaseOrphans(open, factoryLabels)) {
      try {
        const conflicting = phase !== 'review' && (await prMergeable(this.repo, pr.url)).mergeable === 'CONFLICTING';
        if (phase === 'review' || conflicting) {
          const why = phase === 'review'
            ? 'the review that opened this died before it took it up, and the PR it was replacing is reviewed again'
            : `it conflicts with the default branch, and the ${phase} phase works again from what is open now`;
          await closePr(this.repo, pr.url, factoryComment(`🏭 Closing: ${why}.`));
          log(`closed orphaned ${pr.url}: ${why}`);
          continue;
        }
        await ensureLabel(this.repo, label[phase], 'D93F0B', `Opened by the software factory's ${phase} phase`);
        await addPrLabels(this.repo, pr.url, [label[phase]]);
        await markPrReady(this.repo, pr.url);
        const alerts = phase === 'security' ? [...new Set(keysIn(pr.body))] : [];
        await commentOnPr(this.repo, pr.url, factoryComment(`${alerts.length ? `${securityStamp(alerts)}\n` : ''}🏭 The ${phase} pipeline that opened this died before it took it up, so the factory adopted it as it stands: nobody watched its CI.`));
        log(`adopted orphaned ${pr.url} for the ${phase} phase: its pipeline died before labelling it`);
      } catch (err) {
        log(`could not adopt orphaned ${pr.url}: ${(err as Error).message}`);
      }
    }
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
    const openPrs = (await ownPrs(await listPrsByLabel(this.repo, this.config.labels.factoryPr, 'open'), log)).map((pr) => ({
      url: pr.url,
      title: pr.title,
    }));

    const inFlight: CurrentRun[] = [];
    for (const run of this.readRuns()) {
      const ageHours = (Date.now() - Date.parse(run.startedAt)) / 3_600_000;
      // A local run died with its tick: on Oct 13 a full disk killed three
      // pipelines mid-run and their records held three slots until an abort.
      const dead = run.pid !== undefined && !processAlive(run.pid);
      if (ageHours < this.config.staleRunHours && !dead) {
        inFlight.push(run);
        continue;
      }
      log(dead
        ? `dead pipeline for ${run.taskId}: its tick (pid ${run.pid}) is gone; recording as failed and cleaning up`
        : `stale pipeline (${ageHours.toFixed(1)}h old) for ${run.taskId}; recording as failed and cleaning up`);
      this.telemetry.append({
        type: 'run',
        taskId: run.taskId,
        issueNumber: run.issueNumber,
        issueTitle: '',
        worker: this.config.worker.kind,
        model: this.config.worker.model,
        agentId: run.agentId,
        startedAt: run.startedAt,
        finishedAt: new Date().toISOString(),
        outcome: 'aborted',
        failureReason: dead ? `its tick (pid ${run.pid}) exited mid-run` : `stale pipeline older than ${this.config.staleRunHours}h (controller crash?)`,
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
