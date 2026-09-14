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
import { linkedIssueNumber, type PrData } from './github.ts';

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
 * Issues still carrying the in-progress label that nothing is working on: no
 * open factory PR links them and no pipeline on this runner has them in
 * flight. Their PR closed, or their pipeline died, and the label stayed.
 *
 * This is the whole release rule, and it is self-healing: a label a crashed
 * tick leaked, or one a tick with lost telemetry never got to, is released the
 * next time anyone looks.
 */
export function leakedClaims(
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
