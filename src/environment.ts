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

import type { EnvRecord, RunRecord } from './types.ts';

/**
 * Factory PRs no environment pass has read yet, newest first — the same
 * ordering grooming uses, for the same reason. A gap reported months ago is a
 * claim about an environment that has since changed, so oldest-first would
 * spend the pass on the reports least likely to still be true while the live
 * one waits several ticks for its turn.
 *
 * The tail is therefore starved on a busy factory, and that is the intended
 * trade: an unread old PR costs nothing, a stale environment costs every run.
 *
 * Run records outnumber PRs (a retry and its failure can name the same one), so
 * this de-duplicates rather than trusting one record per PR.
 */
export function unexaminedPrUrls(runs: RunRecord[], passes: EnvRecord[]): string[] {
  const seen = new Set(passes.flatMap((p) => p.prsExamined));
  const urls: string[] = [];
  for (let i = runs.length - 1; i >= 0; i--) {
    const prUrl = runs[i]!.prUrl;
    if (prUrl === null || seen.has(prUrl)) continue;
    seen.add(prUrl);
    urls.push(prUrl);
  }
  return urls;
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
  unexamined: string[],
): string | null {
  if (!enabled) return 'environment phase is disabled in factory.config.json';
  if (openEnvPrs.length > 0) {
    return `an environment PR is already awaiting a human (${openEnvPrs.map((p) => p.url).join(', ')})`;
  }
  if (unexamined.length === 0) return 'no factory PRs the environment agent has not already read';
  return null;
}
