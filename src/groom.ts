// Grooming state lives in the issue itself, not in a local file.
//
// The VERDICT is the `factory:groomed` / `factory:needs-work` label: the thing a
// human already reads and can already change. Nothing parses prose to find it.
//
// What a label cannot carry is *what was groomed*, so the factory's verdict
// comment opens with one invisible line:
//
//   <!-- factory-groom sha=a1b2c3d4e5f6 -->
//   🏭 **Factory groom — groomed.** …
//   …why, in the open, attributed to the factory…
//   ## Factory grooming notes
//   …coding-level direction for the implementer…
//
// `sha` fingerprints the human-authored content — the description plus every
// comment the factory did not write. A mismatch means a human has said something
// since, by editing the description or by replying, so the verdict is void and
// the issue is groomed again. This is the only way to notice an edited
// description without a second API call, since bodies and comments arrive
// together and GitHub's timestamps are bumped by the factory's own labelling.
//
// The two records answer different questions, so they cannot contradict each
// other: the label says whether an issue passed, the fingerprint says whether
// that answer is still about the issue as it stands. The label alone decides
// what may be implemented; the fingerprint only decides what gets looked at
// again. An issue can therefore be both — implementable now, and queued for a
// re-review because someone has since replied to it.
//
// Absence of a fingerprint is not evidence against a verdict, only absence of
// evidence for it: an issue labelled by an older version of the factory, or by
// a human, keeps its verdict and gets re-groomed on a later tick.

import { createHash } from 'node:crypto';
import type { GroomVerdict, IssueComment, Task } from './types.ts';

export const NOTES_HEADING = '## Factory grooming notes';

/** Marks a comment as the factory's own, so the fingerprint can ignore it. */
const FACTORY_MARKER = '<!-- factory-comment -->';
const FACTORY_COMMENT_RE = /<!--\s*factory-/;

/** Migration: verdicts used to be stamped into the description itself. */
const LEGACY_BLOCK_RE =
  /[ \t]*<!--\s*factory-groom:start\b[^>]*-->[\s\S]*?<!--\s*factory-groom:end\s*-->[ \t]*\n?/g;

const STAMP_RE = /<!--\s*factory-groom\s+sha=([0-9a-f]+)\s*-->/;

/** The verdict labels, as named in config. */
export interface GroomLabels {
  groomed: string;
  needsWork: string;
}

export type GroomState =
  /** No verdict label: never groomed. */
  | 'ungroomed'
  /** Labelled, but nothing says that verdict is still about this issue. */
  | 'stale'
  /** Labelled, and fingerprinted against the issue as it stands. */
  | 'current';

export function isFactoryComment(body: string): boolean {
  return FACTORY_COMMENT_RE.test(body);
}

/** Wraps a comment the factory writes, so the fingerprint can ignore it. */
export function factoryComment(body: string): string {
  return `${FACTORY_MARKER}\n${body}`;
}

export function hasLegacyBlock(body: string): boolean {
  return body.includes('factory-groom:start');
}

/** The description with any leftover in-body factory block removed. */
export function stripLegacyBlock(body: string): string {
  return body.replace(LEGACY_BLOCK_RE, '');
}

/** Everything a human has said on the issue: the description plus their comments. */
export function humanContent(task: Task): string {
  return [stripLegacyBlock(task.body), ...task.comments.filter((c) => !isFactoryComment(c.body)).map((c) => c.body)]
    .map((s) => s.trim())
    .filter(Boolean)
    .join('\n\n');
}

export function fingerprint(task: Task): string {
  return createHash('sha256').update(humanContent(task)).digest('hex').slice(0, 12);
}

/** The factory's most recent verdict comment, if it has one. */
function latestGroomComment(task: Task): IssueComment | undefined {
  return [...task.comments].reverse().find((c) => STAMP_RE.test(c.body));
}

/** What the issue looked like when the factory last groomed it. */
export function readFingerprint(task: Task): string | null {
  return latestGroomComment(task)?.body.match(STAMP_RE)?.[1] ?? null;
}

/** The verdict of record. */
export function verdict(task: Task, labels: GroomLabels): GroomVerdict | null {
  if (task.labels.includes(labels.groomed)) return 'groomed';
  if (task.labels.includes(labels.needsWork)) return 'needs-work';
  return null;
}

export function groomState(task: Task, labels: GroomLabels): GroomState {
  if (!verdict(task, labels)) return 'ungroomed';
  return readFingerprint(task) === fingerprint(task) ? 'current' : 'stale';
}

/** The implementation direction from the current verdict, if it carried any. */
export function groomNotes(task: Task): string | undefined {
  const body = latestGroomComment(task)?.body ?? '';
  const i = body.indexOf(NOTES_HEADING);
  if (i === -1) return undefined;
  return body.slice(i + NOTES_HEADING.length).trim() || undefined;
}

/**
 * The verdict as the factory publishes it: its conclusion and reasoning in the
 * open where the author can argue with it, over a fingerprint of what it read.
 * Additive by construction — a comment cannot overwrite anything a human wrote.
 */
export function groomComment(task: Task, reply: GroomReply): string {
  const headline =
    reply.verdict === 'groomed'
      ? '🏭 **Factory groom — groomed.** An agent can pick this up as written.'
      : '🏭 **Factory groom — needs work.** The factory is not picking this up as written.';
  const parts = [
    `<!-- factory-groom sha=${fingerprint(task)} -->`,
    `${headline} Edit the description or reply here and it gets reviewed again on a later tick.`,
    reply.reasoning.trim(),
  ];
  if (reply.notes) parts.push(`${NOTES_HEADING}\n\n${reply.notes.trim()}`);
  return parts.filter(Boolean).join('\n\n');
}

/**
 * Never groomed, or groomed against an issue that has since changed.
 *
 * Newest first. A stale issue's premises are false by construction — the code
 * moved underneath it — so oldest-first spends the grooming budget on the part
 * of the backlog least likely to yield anything buildable, and the factory
 * opens no PRs meanwhile because selection only draws from groomed issues.
 *
 * `force` re-grooms issues whose verdict is still current. The fingerprint covers
 * the issue, not the principles, so editing principles.md or the groom prompt
 * leaves every existing verdict looking valid — this is the way to revisit them.
 */
export function needsGroom(tasks: Task[], labels: GroomLabels, force = false): Task[] {
  return tasks
    .filter((t) => force || groomState(t, labels) !== 'current')
    .sort((a, b) => b.issueNumber - a.issueNumber);
}

/**
 * Passed grooming. The label is the verdict of record and nothing else gates
 * this: a fingerprint that no longer matches queues the issue for another look
 * (see `needsGroom`), it does not retract the verdict the factory already gave.
 *
 * So this is deliberately not the complement of `needsGroom` — an issue can be
 * both implementable and due for a re-review, which is the honest reading of
 * "the verdict stands until something replaces it".
 */
export function isGroomed(task: Task, labels: GroomLabels): boolean {
  return verdict(task, labels) === 'groomed';
}

export interface GroomReply {
  verdict: GroomVerdict;
  notes: string | undefined;
  reasoning: string;
}

/**
 * Parse the groom agent's reply: a trailing verdict line, and optionally a
 * fenced ```notes block. Returns null if there is no verdict to act on — a
 * groom with no verdict is skipped, not guessed at.
 */
export function parseGroomReply(text: string): GroomReply | null {
  const verdicts = [...text.matchAll(/^\s*VERDICT:\s*(groomed|needs[-_ ]?work)\s*$/gim)];
  const last = verdicts.at(-1);
  if (!last) return null;
  const verdict: GroomVerdict = /^groomed$/i.test(last[1]!) ? 'groomed' : 'needs-work';

  const noteBlocks = [...text.matchAll(/```notes[ \t]*\n([\s\S]*?)```/g)];
  const notes = noteBlocks.at(-1)?.[1]?.trim() || undefined;

  // The reasoning is everything except the machinery, for the issue comment.
  const reasoning = text
    .replace(/```notes[ \t]*\n[\s\S]*?```/g, '')
    .replace(/^\s*VERDICT:\s*(groomed|needs[-_ ]?work)\s*$/gim, '')
    .trim();

  return { verdict, notes, reasoning };
}
