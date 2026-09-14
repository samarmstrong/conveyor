// The simplification phase pushes the other way from everything else the
// factory launches.
//
// An autonomous implementer accretes complexity: every PR is locally reasonable
// — a helper here, a fallback there, a hand-rolled loop where the SDK already
// had one — and the sum stops being something a person can hold in their head.
// Left alone, that is what ends an autonomous codebase. So one agent's only job
// is to remove code, and the phase is opinionated about what "simpler" means:
// the PR must delete more lines than it adds, as GitHub counts them. That is the
// one thing the controller checks itself, because it is one number GitHub
// already computes and because the failure mode is specific — an agent that
// "simplifies" by adding an abstraction, or a test asserting that the thing it
// deleted is gone. A PR that grows the code is closed before a human sees it.
//
// Like the environment phase it is handed no issue and parses no prose. The
// input is the codebase plus links to the factory's own merged PRs, which is
// where the newest complexity is; the output is whether a branch came back and
// what its line count says. One simplification PR is open at a time.
//
// Those inputs come from GitHub — merged PRs by label, declined ones by label
// and state — not from telemetry, for the reason environment.ts gives. The one
// thing read from telemetry is the commit the last pass judged, and that only
// saves a redundant pass on an idle day: stale telemetry names an old commit,
// the head has moved, the pass runs. It cannot make the factory skip work it
// should do.

import type { SimplifyRecord } from './types.ts';

/** Merged implementer PRs, newest first: the first place to look for accretion. */
export function recentlyMergedFactoryPrs(prs: { url: string; mergedAt: string | null }[], limit: number): string[] {
  return prs
    .filter((p): p is { url: string; mergedAt: string } => p.mergedAt !== null)
    .sort((a, b) => b.mergedAt.localeCompare(a.mergedAt))
    .slice(0, limit)
    .map((p) => p.url);
}

/**
 * Simplifications a human closed unmerged. The agent is told not to propose
 * them again. A closed simplification that grew the code was closed by the
 * factory, not a human, and is not held against the idea — that one may come
 * back done right.
 */
export function declinedSimplifications(prs: { url: string; state: string; additions: number; deletions: number }[]): string[] {
  return prs.filter((p) => p.state === 'CLOSED' && shrinks(p)).map((p) => p.url);
}

/** The rule the factory enforces: a simplification removes more than it adds. */
export function shrinks(pr: { additions: number; deletions: number }): boolean {
  return pr.deletions > pr.additions;
}

/**
 * Why a pass is not running, or null if it should. Kept together so `factory
 * simplify`, `factory status`, and the tick give the same answer.
 *
 * A pass that reached a conclusion on this commit is not repeated: it found
 * nothing, or a human has the result, or a human declined it. Only the code
 * changing makes another look worthwhile. A failed pass says nothing about the
 * code and is retried.
 */
export function skipReason(
  enabled: boolean,
  openPrs: { url: string }[],
  passes: SimplifyRecord[],
  baseSha: string | null,
): string | null {
  if (!enabled) return 'simplification phase is disabled in factory.config.json';
  if (openPrs.length > 0) {
    return `a simplification PR is already awaiting a human (${openPrs.map((p) => p.url).join(', ')})`;
  }
  const last = passes.at(-1);
  if (last && last.outcome !== 'failed' && baseSha !== null && last.baseSha === baseSha) {
    return `the last pass already looked at ${baseSha.slice(0, 8)} (${last.outcome}) and the code has not changed since`;
  }
  return null;
}
