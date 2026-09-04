// The environment phase owns the machine the factory's coding agents run on.
//
// An implementer that cannot verify its own change writes so, plainly, in the
// PR it opens — "could not run the job here, this environment has no Docker".
// That sentence is the whole signal, and it is already published in the one
// place a human would look for it. So this phase does not ask the implementer
// for a structured report and does not parse one out of its reply: it hands
// another agent the PR *links* and lets it read them, exactly the way grooming
// is handed an issue link rather than the issue's text.
//
// The pass's own verdict is structural for the same reason. The environment
// agent either opens a PR against `.cursor/` — there was a gap and this closes
// it — or it does not. Nothing here parses prose; the branch the agent pushed
// is the answer, which is the same handoff `runPipeline` already reads from an
// implementer.
//
// The only state is telemetry. Each pass records the PRs it read, so the next
// one reads only what is new; a pass that failed records none of them, and
// they come back around.
//
// Telemetry also dates the environment itself. A report is a claim about the
// machine the agent ran on, so a merged environment PR voids every report
// written before it — the same move the groom fingerprint makes when a human
// replies to an issue. Without that, a pass reads complaints about a machine
// that no longer exists and "fixes" what is already fixed.

import type { EnvRecord, OutcomeRecord, RunRecord } from './types.ts';

/**
 * When the agents' machine last actually changed: the merge time of the most
 * recent merged environment PR, or null if none has ever merged.
 */
export function environmentChangedAt(outcomes: OutcomeRecord[]): string | null {
  const merged = outcomes
    .filter((o) => o.source === 'environment' && o.merged)
    .map((o) => o.closedAt)
    .sort();
  return merged.at(-1) ?? null;
}

/** Unread factory PRs, split by whether their reports are still about this machine. */
export interface UnreadPrs {
  /** Opened by an agent that ran on the environment as it stands. Worth reading. */
  fresh: string[];
  /** Opened before the environment last changed, so never read at all. */
  stale: string[];
}

/**
 * Factory PRs no environment pass has read yet, newest first — the same
 * ordering grooming uses, for the same reason.
 *
 * `changedAt` splits them. A run that *started* before the environment changed
 * necessarily ran on the old machine, whatever it later said, so `startedAt` is
 * the honest cutoff rather than when its PR happened to open.
 *
 * Stale reports are dropped, not deferred: if the gap one describes still
 * exists, the next implementer hits it and says so in a PR opened after the
 * change, and that one is read. Only evidence about the current machine counts.
 *
 * Run records outnumber PRs (a retry and its failure can name the same one), so
 * this de-duplicates rather than trusting one record per PR.
 */
export function unreadFactoryPrs(
  runs: RunRecord[],
  passes: EnvRecord[],
  changedAt: string | null,
): UnreadPrs {
  const seen = new Set(passes.flatMap((p) => p.prsExamined));
  const unread: UnreadPrs = { fresh: [], stale: [] };
  for (let i = runs.length - 1; i >= 0; i--) {
    const { prUrl, startedAt } = runs[i]!;
    if (prUrl === null || seen.has(prUrl)) continue;
    seen.add(prUrl);
    (changedAt !== null && startedAt < changedAt ? unread.stale : unread.fresh).push(prUrl);
  }
  return unread;
}

/**
 * Why a pass is not running, or null if it should. Kept together so `factory
 * env` and the tick give the same answer for the same reason.
 *
 * One open environment PR is the cap, and it is a rule rather than a knob: a
 * second pass would be reading PRs whose gaps the first one has already
 * proposed a fix for, and reviewing two competing `.cursor/environment.json`
 * diffs is worse than waiting.
 */
export function skipReason(
  enabled: boolean,
  openEnvPrs: { url: string }[],
  unread: UnreadPrs,
  changedAt: string | null = null,
): string | null {
  if (!enabled) return 'environment phase is disabled in factory.config.json';
  if (openEnvPrs.length > 0) {
    return `an environment PR is already awaiting a human (${openEnvPrs.map((p) => p.url).join(', ')})`;
  }
  if (unread.fresh.length > 0) return null;
  if (unread.stale.length > 0) {
    return `${unread.stale.length} unread factory PR(s), but all opened before the environment last changed (${changedAt}) — their reports describe a machine that no longer exists`;
  }
  return 'no factory PRs the environment agent has not already read';
}
