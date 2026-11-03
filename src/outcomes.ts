// Reconciliation: what happened to the PRs the factory opened, and what that
// frees up. Decided from GitHub, recorded to telemetry.
//
// The two are kept apart on purpose. The decision — which issues are still
// claimed, which PRs closed — has to be right on every runner, including one
// whose telemetry never persisted; GitHub already knows both answers, and asking
// it is idempotent. The record — outcome rows for the dataset that will one day
// say which classes of task can automerge — only has to be complete, and a row
// written twice is a nuisance rather than a wrong action. So telemetry dedupes
// the record, and nothing here reads telemetry to decide anything.

import type { OutcomeRecord } from './types.ts';
import { linkedIssueNumber, type LabelHistory, type PrData } from './github.ts';

export type Source = NonNullable<OutcomeRecord['source']>;

/** A factory PR with the pipeline that opened it, known from the label it carries. */
export type SourcedPr = PrData & { source: Source };

export function withSource(prs: PrData[], source: Source): SourcedPr[] {
  return prs.map((pr) => ({ ...pr, source }));
}

/**
 * Outcome rows for factory PRs that have closed and are not yet in the record,
 * one per PR. Merged or not, both are verdicts; an open PR is not one yet.
 */
export function unrecordedOutcomes(prs: SourcedPr[], recorded: Set<string>, now = new Date().toISOString()): OutcomeRecord[] {
  const seen = new Set(recorded);
  const rows: OutcomeRecord[] = [];
  for (const pr of prs) {
    if (pr.state === 'OPEN' || seen.has(pr.url)) continue;
    seen.add(pr.url);
    rows.push({
      type: 'outcome',
      prUrl: pr.url,
      source: pr.source,
      // Environment and simplification PRs claim no issue.
      issueNumber: pr.source === 'implementer' ? linkedIssueNumber(pr.body) : null,
      merged: pr.state === 'MERGED',
      closedAt: pr.mergedAt ?? pr.closedAt ?? now,
      humanChangeRequests: pr.reviews.filter((r) => r.state === 'CHANGES_REQUESTED').length,
      humanCommentCount: pr.comments.length,
      recordedAt: now,
    });
  }
  return rows;
}

/**
 * Implementer PRs a dead pipeline left behind, each with the issue it closes.
 * The pipeline labels its PR only after its agent finishes, so a tick that
 * dies first — a cancelled runner, a launch whose response was lost while the
 * agent started anyway — leaves an unlabelled draft, and its issue, claimed by
 * no factory PR, is picked again and built twice. Such a PR is recognised by
 * what the factory itself set: Cursor names the branch after the agent
 * (`factory: #N …` becomes `cursor/factory-N-…`), and the body closes #N as
 * the implement prompt asks. Nothing else the factory or a human opens has both.
 */
export function orphanedPrs<P extends PrData & { labels: { name: string }[] }>(
  open: P[],
  factoryLabels: string[],
): { pr: P; issue: number }[] {
  const orphans: { pr: P; issue: number }[] = [];
  for (const pr of open) {
    if (pr.labels.some((l) => factoryLabels.includes(l.name))) continue;
    const branch = pr.headRefName.match(/^cursor\/factory-(\d+)-/);
    if (branch && linkedIssueNumber(pr.body) === Number(branch[1])) orphans.push({ pr, issue: Number(branch[1]) });
  }
  return orphans;
}

/** The phases that open PRs on their own agent's branch, as Cursor names it after the agent (`factory-security` → `cursor/factory-security-…`). */
export type OrphanPhase = 'security' | 'env' | 'simplify' | 'deps' | 'review';

/**
 * PRs the other phases' dead pipelines left behind — the same death as
 * `orphanedPrs`, on a phase's branch instead of an issue's. On Oct 2 a
 * security fixer's pipeline died on a socket error, its agent opened #1442
 * anyway, and it sat unlabelled for a day: the merging babysitter takes only
 * labelled PRs, and the review phase skips a draft.
 */
export function phaseOrphans<P extends PrData & { labels: { name: string }[] }>(
  open: P[],
  factoryLabels: string[],
): { pr: P; phase: OrphanPhase }[] {
  const orphans: { pr: P; phase: OrphanPhase }[] = [];
  for (const pr of open) {
    if (pr.labels.some((l) => factoryLabels.includes(l.name))) continue;
    const m = pr.headRefName.match(/^cursor\/factory-(security|env|simplify|deps|review)-/);
    if (m) orphans.push({ pr, phase: m[1] as OrphanPhase });
  }
  return orphans;
}

/**
 * Whether a PR is old enough that no live pipeline could still be about to
 * label it. A pipeline labels its PR once its agent's run ends, and the PR
 * cannot be older than the run, so past the run budget it is an orphan. Short
 * of it, it may be another runner's: on a local tick, an Actions pipeline's
 * Cursor PR is unlabelled for the poll between its agent opening it and the
 * pipeline taking it up, and adopting it then would say its pipeline died, or
 * close a review's replacement out from under it.
 */
export function pastGrace(pr: { createdAt: string }, graceMs: number, now = Date.now()): boolean {
  return !(now - Date.parse(pr.createdAt) < graceMs);
}

/**
 * Issues still carrying the in-progress label that nothing here holds: no open
 * factory PR links them and no pipeline on this runner has them in flight.
 * Their PR closed, or their pipeline died — or it is running on another
 * machine, which this runner cannot see. `leakedClaims` tells those apart.
 */
export function unheldClaims(
  claimed: { number: number }[],
  openPrs: { body: string }[],
  inFlight: { issueNumber: number }[],
): number[] {
  const held = new Set<number>(inFlight.map((r) => r.issueNumber));
  for (const pr of openPrs) {
    const n = linkedIssueNumber(pr.body);
    if (n !== null) held.add(n);
  }
  return claimed.map((i) => i.number).filter((n) => !held.has(n));
}

/**
 * Issues an open factory PR answers that carry no claim, whichever runner
 * opened the PR. Picks skip only claimed issues, so one of these is built
 * again: on Oct 26 another runner's open PR closed a groomed issue whose
 * claim was gone, and the next tick here would have taken it.
 */
export function unclaimedAnswers(openPrs: { body: string }[], claimed: { number: number }[]): number[] {
  const have = new Set(claimed.map((i) => i.number));
  const answered = openPrs.map((pr) => linkedIssueNumber(pr.body)).filter((n): n is number => n !== null);
  return [...new Set(answered)].filter((n) => !have.has(n));
}

/**
 * Of the claims nothing here holds, the ones nothing anywhere does. A claim
 * whose factory PR has closed since it was made is leaked: the pipeline that
 * made it got as far as its PR, and that PR is settled. Any other is leaked
 * once it is older than `maxAgeMs`, which is `staleRunHours` — the age at
 * which the runner holding a pipeline counts it dead and releases it itself.
 * The run budget is no bound: a local pipeline holds its claim through a
 * subscription's usage wait and through a sleeping Mac. On Oct 14 an Actions
 * tick released #2269 and #2270 while a local tick was building them.
 *
 * This is the whole release rule, and it is self-healing: a label a crashed
 * tick leaked is released by the next tick, on any runner, once it is that
 * old. An issue whose history could not be read is held for this tick.
 */
export function leakedClaims(
  unheld: number[],
  history: Map<number, Pick<LabelHistory, 'labelledAt'>>,
  closedPrs: { body: string; closedAt: string | null; mergedAt: string | null }[],
  label: string,
  maxAgeMs: number,
  now = Date.now(),
): number[] {
  return unheld.filter((n) => {
    const h = history.get(n);
    if (!h) return false;
    const claimedAt = Date.parse(h.labelledAt[label] ?? '');
    if (Number.isNaN(claimedAt)) return true;
    const settled = closedPrs.some((pr) =>
      linkedIssueNumber(pr.body) === n && Date.parse(pr.closedAt ?? pr.mergedAt ?? '') >= claimedAt);
    return settled || now - claimedAt >= maxAgeMs;
  });
}

/**
 * Open issues a merged factory PR has spent the groom verdict of. A groom may
 * scope one slice of an issue, its PR then says "Part of #N", and the issue
 * stays open when it merges — still groomed, so it was picked again, and the
 * next agent found its slice done and opened nothing. A verdict last put on
 * before the merge is about the issue as it was: taking its label off leaves
 * the issue ungroomed, so nothing implements it until the remainder is groomed. One put on after the merge is that groom,
 * and stands. An epic's verdict is a direction, not one PR, and its slice has
 * its own staleness rule (groom.ts), so it is left alone.
 */
export function spentVerdicts(
  prs: PrData[],
  history: Map<number, LabelHistory>,
  labels: { groomed: string; epic?: string },
): { issue: number; prUrl: string }[] {
  const spent = new Map<number, string>();
  for (const pr of prs) {
    const n = pr.state === 'MERGED' ? linkedIssueNumber(pr.body) : null;
    const h = n === null ? undefined : history.get(n);
    if (n === null || !h?.open || spent.has(n) || !h.labels.includes(labels.groomed)) continue;
    if (labels.epic !== undefined && h.labels.includes(labels.epic)) continue;
    if (!(Date.parse(h.labelledAt[labels.groomed] ?? '') > Date.parse(pr.mergedAt ?? ''))) spent.set(n, pr.url);
  }
  return [...spent].map(([issue, prUrl]) => ({ issue, prUrl }));
}
