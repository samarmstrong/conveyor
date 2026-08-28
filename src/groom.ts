// Grooming state lives in the issue itself, not in a local file.
//
// A groomed issue carries one invisible block at the end of its body:
//
//   <!-- factory-groom:start sha=a1b2c3d4e5f6 verdict=groomed -->
//   ## Factory grooming notes
//   …coding-level direction for the implementer…
//   <!-- factory-groom:end -->
//
// `sha` fingerprints the human-authored part of the body (this block stripped).
// So: no block means never groomed, and a fingerprint mismatch means someone
// edited the description since — the verdict is void and the issue is groomed
// again. That is the whole answer to "what if the description changes later",
// and it costs no extra API calls, since issue bodies are already fetched.

import { createHash } from 'node:crypto';
import type { GroomVerdict, Task } from './types.ts';

export const NOTES_HEADING = '## Factory grooming notes';

const BLOCK_RE =
  /[ \t]*<!--\s*factory-groom:start\b[^>]*-->[\s\S]*?<!--\s*factory-groom:end\s*-->[ \t]*\n?/g;

export interface GroomStamp {
  sha: string;
  verdict: GroomVerdict;
}

export type GroomState =
  /** No factory block: never groomed. */
  | { kind: 'ungroomed' }
  /** Groomed, but the human-authored body has changed since. Groom it again. */
  | { kind: 'stale'; previous: GroomStamp }
  /** Groomed, and the body is unchanged since the verdict. */
  | { kind: 'current'; stamp: GroomStamp };

/** The issue body with every factory block removed — what a human wrote. */
export function humanBody(body: string): string {
  return body.replace(BLOCK_RE, '');
}

/** Fingerprint of the human-authored body. Accepts a full or already-stripped body. */
export function fingerprint(body: string): string {
  return createHash('sha256').update(humanBody(body).trim()).digest('hex').slice(0, 12);
}

export function readStamp(body: string): GroomStamp | null {
  const m = body.match(/<!--\s*factory-groom:start\b([^>]*)-->/);
  if (!m) return null;
  const attrs = m[1] ?? '';
  const sha = attrs.match(/sha=([0-9a-f]+)/)?.[1];
  const verdict = attrs.match(/verdict=([\w-]+)/)?.[1];
  if (!sha || (verdict !== 'groomed' && verdict !== 'needs-work')) return null;
  return { sha, verdict };
}

export function groomState(body: string): GroomState {
  const stamp = readStamp(body);
  if (!stamp) return { kind: 'ungroomed' };
  if (stamp.sha !== fingerprint(body)) return { kind: 'stale', previous: stamp };
  return { kind: 'current', stamp };
}

/**
 * Stamp a verdict onto an issue body: strips any previous factory block, then
 * appends a fresh one. Additive with respect to the human's text — the factory
 * never rewrites a description, it only appends to it.
 */
export function stampBody(body: string, verdict: GroomVerdict, notes?: string): string {
  const human = humanBody(body).trimEnd();
  const sha = fingerprint(human);
  const trimmedNotes = notes?.trim();
  const section = trimmedNotes ? `\n${NOTES_HEADING}\n\n${trimmedNotes}\n` : '\n';
  return `${human}\n\n<!-- factory-groom:start sha=${sha} verdict=${verdict} -->${section}<!-- factory-groom:end -->\n`;
}

/**
 * Never groomed, or groomed against a description that has since changed.
 *
 * Newest first. A stale issue's premises are false by construction — the code
 * moved underneath it — so oldest-first spends the grooming budget on the part
 * of the backlog least likely to yield anything buildable, and the factory
 * opens no PRs meanwhile because selection only draws from groomed issues.
 *
 * `force` re-grooms issues whose verdict is still current. The stamp fingerprints
 * the issue, not the principles, so editing principles.md or the groom prompt
 * leaves every existing verdict looking valid — this is the way to revisit them.
 */
export function needsGroom(tasks: Task[], force = false): Task[] {
  return tasks
    .filter((t) => force || groomState(t.body).kind !== 'current')
    .sort((a, b) => b.issueNumber - a.issueNumber);
}

/** Passed grooming, against the description as it stands now. */
export function isGroomed(task: Task): boolean {
  const state = groomState(task.body);
  return state.kind === 'current' && state.stamp.verdict === 'groomed';
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
