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

//
// One thing in the report is not prose to the factory: a repo defect. A
// "Blocked by the machine" item is sometimes neither the image's fault nor the
// implementer's — the repo as shipped does not start, or rejects its own
// service-to-service calls — and the environment agent can only say so. It
// said so twice, on two PRs, for one CSRF bug, and nobody filed the issue. So
// the agent writes the defect as a fenced ```issue block, the same shape the
// groomer uses for an epic's children, and the factory files it. The groomer
// then judges it like any other issue; the environment agent's job ends at
// naming it.

import { parseDraftBlocks, type ChildDraft } from './groom.ts';

/** What the pass posts on every PR it reads. Its presence is the "read" mark. */
export const ENV_AGENT_MARK = '**Factory environment agent.**';

/** A repo defect the environment agent wrote up, before it has a number. */
export type IssueDraft = ChildDraft;

/**
 * The environment agent's reply, split: the issues it asks the factory to
 * file, and the report that is posted to the PRs it read with those blocks
 * removed — the filed issues are linked there instead.
 */
export function parseEnvReport(text: string): { report: string; issues: IssueDraft[] } {
  const { drafts, rest } = parseDraftBlocks(text, 'issue');
  return { report: rest, issues: drafts };
}

/**
 * The body of an issue the pass files: where the evidence is, then the
 * agent's write-up. The PR links are the provenance a groomer follows, the
 * way a child's first line names its epic.
 */
export function filedIssueBody(draft: IssueDraft, prUrls: string[]): string {
  const from = prUrls.length === 1 ? `Reported by the implementer of ${prUrls[0]}` : `Reported by the implementers of ${prUrls.join(', ')}`;
  return `${from} under **Blocked by the machine**; the factory's environment agent read it as a defect in the repo, not the machine, and filed it.\n\n${draft.body}`.trimEnd() + '\n';
}

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
 * Factory PRs no environment pass has read yet, newest first: the newest
 * report is the one most likely to describe the machine as it is now.
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
 * The PRs this tick just opened, put in front of what GitHub listed. GitHub's
 * label index lags a label write by a few seconds, and the pass lists PRs by
 * label seconds after the implementers labelled theirs: on one target-repo tick the
 * gap was five seconds and the pass read the day's other two PRs and not the
 * newest. The tick knows what it opened; it does not need GitHub to confirm.
 * Nothing else changes — a PR that was already listed, or already read, is
 * not repeated.
 */
export function withOpenedThisTick(unread: UnreadPrs, opened: string[]): UnreadPrs {
  const known = new Set([...unread.fresh, ...unread.stale]);
  const missing = opened.filter((url, i) => !known.has(url) && opened.indexOf(url) === i);
  return missing.length === 0 ? unread : { fresh: [...missing, ...unread.fresh], stale: unread.stale };
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
/**
 * Why the phase does not apply to this worker at all, or null. It edits
 * `.cursor/environment.json`: the machine Cursor's agents get. Claude Code
 * agents run on the machine running the tick and install what they lack as
 * they go, so there is no environment file to write for them.
 */
export function workerSkipReason(workerKind: string): string | null {
  if (workerKind === 'cursor') return null;
  return `the environment phase only applies to the cursor worker (worker.kind is ${workerKind}); local agents fix their own machine`;
}

export function skipReason(
  enabled: boolean,
  openEnvPrs: { url: string }[],
  unread: UnreadPrs,
  changedAt: string | null = null,
  workerKind: string = 'cursor',
): string | null {
  if (!enabled) return 'environment phase is disabled in factory.config.json';
  const worker = workerSkipReason(workerKind);
  if (worker) return worker;
  if (openEnvPrs.length > 0) {
    return `an environment PR is already awaiting a human (${openEnvPrs.map((p) => p.url).join(', ')})`;
  }
  if (unread.fresh.length > 0) return null;
  if (unread.stale.length > 0) {
    return `${unread.stale.length} unread factory PR(s), but all opened before the environment last changed (${changedAt}) — their reports describe a machine that no longer exists`;
  }
  return 'no factory PRs the environment agent has not already read';
}
