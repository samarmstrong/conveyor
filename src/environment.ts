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
// Every input comes from GitHub, none from telemetry. The factory PRs are the
// ones carrying the factory label; a PR has been read when the environment
// agent's comment is on it, which the pass posts on every PR it reads anyway;
// and the environment last changed when the newest environment-labelled PR
// merged. Telemetry records each pass but decides nothing. This phase once read
// run records instead, and a tick whose telemetry failed to persist — the
// GitHub Actions runner, for a week — re-read the same two PRs every day while
// never learning the newer ones existed. GitHub is where the PRs are; asking it
// is correct from any machine.
//
// A merged environment PR voids every report written before it. A report is a
// claim about the machine the agent ran on, so once that machine changes the
// claim is about something that no longer exists — the same move the groom
// fingerprint makes when a human replies to an issue. Without that, a pass
// reads complaints about a machine that no longer exists and "fixes" what is
// already fixed.

/** What the pass posts on every PR it reads. Its presence is the "read" mark. */
export const ENV_AGENT_MARK = '**Factory environment agent.**';

/** The slice of a GitHub PR this phase reasons about. */
export interface FactoryPr {
  url: string;
  createdAt: string;
  comments: { body: string; url: string }[];
}

/**
 * When the agents' machine last actually changed: the merge time of the most
 * recent merged environment PR, or null if none has ever merged.
 */
export function environmentChangedAt(envPrs: { mergedAt: string | null }[]): string | null {
  const merged = envPrs.map((p) => p.mergedAt).filter((t): t is string => t !== null).sort();
  return merged.at(-1) ?? null;
}

/** Unread factory PRs, split by whether their reports are still about this machine. */
export interface UnreadPrs {
  /** Opened by an agent that ran on the environment as it stands. Worth reading. */
  fresh: string[];
  /** Opened before the environment last changed, so never read at all. */
  stale: string[];
}

function readByEnvAgent(pr: FactoryPr): boolean {
  return pr.comments.some((c) => c.body.includes(ENV_AGENT_MARK));
}

function newestFirst(prs: FactoryPr[]): FactoryPr[] {
  return [...prs].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
}

/**
 * Factory PRs no environment pass has read yet, newest first — the same
 * ordering grooming uses, for the same reason.
 *
 * `changedAt` splits them. A PR opened before the environment changed was
 * written on the old machine, whatever it says. (The run that opened it started
 * earlier still, so a PR opened just after the change may also describe the old
 * machine; that pass finds nothing to fix and its comment retires the PR.)
 *
 * Stale reports are dropped, not deferred: if the gap one describes still
 * exists, the next implementer hits it and says so in a PR opened after the
 * change, and that one is read. Only evidence about the current machine counts.
 */
export function unreadFactoryPrs(prs: FactoryPr[], changedAt: string | null): UnreadPrs {
  const unread: UnreadPrs = { fresh: [], stale: [] };
  for (const pr of newestFirst(prs)) {
    if (readByEnvAgent(pr)) continue;
    (changedAt !== null && pr.createdAt < changedAt ? unread.stale : unread.fresh).push(pr.url);
  }
  return unread;
}

/**
 * The environment agent's most recent verdicts, newest PR first: a link to the
 * last comment it left on each. Handed back to the next pass so a gap that
 * shows up as a shrug in every PR — "installed the deps myself" — is seen as
 * the pattern it is, rather than dismissed one PR at a time. One per PR: a tick
 * that could not persist its telemetry used to re-read the same PRs, and two
 * verdicts on one PR are one verdict.
 */
export function recentVerdicts(prs: FactoryPr[], limit: number): string[] {
  return newestFirst(prs)
    .flatMap((pr) => pr.comments.filter((c) => c.body.includes(ENV_AGENT_MARK)).map((c) => c.url).slice(-1))
    .slice(0, limit);
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
