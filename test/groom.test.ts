import { describe, expect, it } from 'vitest';
import {
  fingerprint, groomComment, groomNotes, groomState, hasLegacyBlock, isGroomed, needsGroom,
  parseGroomReply, readFingerprint, stripLegacyBlock, verdict,
} from '../src/groom.ts';
import type { GroomVerdict, IssueComment, Task } from '../src/types.ts';

function task(issueNumber: number, body: string, comments: string[] = [], labels: string[] = []): Task {
  return {
    id: `o/r#${issueNumber}`,
    issueNumber,
    title: `task ${issueNumber}`,
    body,
    comments: comments.map((c): IssueComment => ({ body: c })),
    labels,
    url: `https://github.com/o/r/issues/${issueNumber}`,
  };
}

const LABELS = { groomed: 'factory:groomed', needsWork: 'factory:needs-work' };

/** The issue as the factory leaves it: its verdict comment, and the matching label. */
function verdictOn(t: Task, v: GroomVerdict, notes?: string): Task {
  const comment = groomComment(t, { verdict: v, notes, reasoning: 'Because of the worker boundary.' });
  return {
    ...t,
    comments: [...t.comments.map((c) => c.body), comment].map((body) => ({ body })),
    labels: [...t.labels, v === 'groomed' ? LABELS.groomed : LABELS.needsWork],
  };
}

const original = 'The llm-worker should validate Settings at startup.\n\nSee services/worker.';

describe('stamping and fingerprinting', () => {
  it('records the verdict in a comment, leaving the description untouched', () => {
    const groomed = verdictOn(task(1, original), 'groomed', 'Stay inside services/worker; do not touch callers.');
    expect(groomed.body).toBe(original);
    expect(groomed.comments).toHaveLength(1);
    expect(groomed.comments[0]!.body).toContain('Because of the worker boundary.');
    expect(groomNotes(groomed)).toBe('Stay inside services/worker; do not touch callers.');
  });

  it('comments its conclusion on a pass as well as a rejection', () => {
    for (const v of ['groomed', 'needs-work'] as const) {
      const t = verdictOn(task(1, original), v);
      expect(verdict(t, LABELS)).toBe(v);
      expect(groomState(t, LABELS)).toBe('current');
      expect(t.comments[0]!.body).toContain('Because of the worker boundary.');
    }
  });

  it('treats an unlabelled issue as never groomed', () => {
    expect(groomState(task(1, original), LABELS)).toBe('ungroomed');
    expect(groomState(task(1, original, ['Agreed, this bites us weekly.']), LABELS)).toBe('ungroomed');
  });

  it('does not re-groom an issue it just recorded', () => {
    expect(groomState(verdictOn(task(1, original), 'groomed', 'notes here'), LABELS)).toBe('current');
  });

  it('trusts a label it cannot date, and queues it for another look', () => {
    // An issue labelled by an older factory, or by hand: absence of a fingerprint
    // is not evidence against the verdict, so it stays implementable meanwhile.
    const undated = task(1, original, [], [LABELS.groomed]);
    expect(readFingerprint(undated)).toBeNull();
    expect(isGroomed(undated, LABELS)).toBe(true);
    expect(groomState(undated, LABELS)).toBe('stale');
    expect(needsGroom([undated], LABELS)).toHaveLength(1);
  });

  it('keeps a groomed issue implementable while its re-review is pending', () => {
    const groomed = verdictOn(task(1, original), 'groomed');
    const replied = { ...groomed, comments: [...groomed.comments, { body: 'One more thought.' }] };
    expect(groomState(replied, LABELS)).toBe('stale');
    expect(needsGroom([replied], LABELS)).toHaveLength(1);
    expect(isGroomed(replied, LABELS)).toBe(true);
  });

  it('re-grooms once a human strips the label off a groomed issue', () => {
    const groomed = verdictOn(task(1, original), 'groomed');
    expect(needsGroom([groomed], LABELS)).toHaveLength(0);
    expect(needsGroom([{ ...groomed, labels: [] }], LABELS)).toHaveLength(1);
  });

  it('ignores its own later chatter, which would otherwise void every verdict', () => {
    const groomed = verdictOn(task(1, original), 'groomed');
    const withChatter = task(1, original, [
      ...groomed.comments.map((c) => c.body),
      '<!-- factory-comment -->\n🏭 The factory opened a PR for this issue.',
      '<!-- factory-comment -->\n🏭 The factory could not open a PR.',
    ], groomed.labels);
    expect(groomState(withChatter, LABELS)).toBe('current');
  });

  it('goes stale when a human edits the description', () => {
    const groomed = verdictOn(task(1, original), 'groomed', 'notes');
    const edited = { ...groomed, body: original.replace('at startup', 'at every call site') };
    expect(groomState(edited, LABELS)).toBe('stale');
  });

  it('goes stale when a human comments — grooming judges description and comments together', () => {
    const groomed = verdictOn(task(1, original), 'groomed');
    const replied = task(1, original, [...groomed.comments.map((c) => c.body), 'Actually only the worker boundary.'], groomed.labels);
    expect(groomState(replied, LABELS)).toBe('stale');
  });

  it('re-reviews a needs-work issue once someone answers it', () => {
    const rejected = verdictOn(task(1, original), 'needs-work');
    expect(needsGroom([rejected], LABELS)).toHaveLength(0);
    const rescoped = task(1, original, [...rejected.comments.map((c) => c.body), 'Rescoped: only the worker boundary.'], rejected.labels);
    expect(needsGroom([rescoped], LABELS)).toHaveLength(1);
  });

  it('fingerprints the human text only, whitespace aside', () => {
    const groomed = verdictOn(task(1, original), 'groomed', 'notes');
    expect(fingerprint(groomed)).toBe(fingerprint(task(1, original)));
    expect(fingerprint(task(1, `${original}\n`))).toBe(fingerprint(task(1, original)));
  });
});

describe('legacy in-body stamps', () => {
  const legacy = `${original}\n\n<!-- factory-groom:start sha=abc123 verdict=groomed -->\n## Factory grooming notes\n\nold notes\n<!-- factory-groom:end -->\n`;

  it('no longer counts as a verdict — the issue is groomed again, into a comment', () => {
    expect(hasLegacyBlock(legacy)).toBe(true);
    expect(groomState(task(1, legacy), LABELS)).toBe('ungroomed');
    expect(groomState(task(1, legacy, [], [LABELS.groomed]), LABELS)).toBe('stale');
  });

  it('is excluded from the fingerprint, so cleaning it up does not void the new verdict', () => {
    expect(fingerprint(task(1, legacy))).toBe(fingerprint(task(1, original)));
    expect(stripLegacyBlock(legacy).trim()).toBe(original);
  });
});

describe('backlog filters', () => {
  const groomed = verdictOn(task(10, 'a'), 'groomed');
  const rejected = verdictOn(task(11, 'b'), 'needs-work');
  const fresh = task(12, 'c');
  const stale = { ...verdictOn(task(9, 'd'), 'groomed'), body: 'd rewritten' };

  it('grooms the ungroomed and the stale, newest first', () => {
    expect(needsGroom([groomed, rejected, fresh, stale], LABELS).map((t) => t.issueNumber)).toEqual([12, 9]);
  });

  it('offers every issue carrying the groomed label for implementation', () => {
    expect([groomed, rejected, fresh, stale].filter((t) => isGroomed(t, LABELS)).map((t) => t.issueNumber)).toEqual([10, 9]);
  });
});

describe('parseGroomReply', () => {
  it('parses a verdict with notes', () => {
    const reply = [
      'This is worth doing, but the issue asks for a new config layer we do not need.',
      '',
      '```notes',
      'Reuse Settings in core/platform/config.py. Do not add a second validator.',
      '```',
      '',
      'VERDICT: groomed',
    ].join('\n');
    const parsed = parseGroomReply(reply);
    expect(parsed).toMatchObject({ verdict: 'groomed' });
    expect(parsed!.notes).toBe('Reuse Settings in core/platform/config.py. Do not add a second validator.');
    expect(parsed!.reasoning).toContain('new config layer');
    expect(parsed!.reasoning).not.toContain('VERDICT:');
    expect(parsed!.reasoning).not.toContain('Reuse Settings');
  });

  it('parses a bare verdict with no notes', () => {
    const parsed = parseGroomReply('Clear and well-scoped as written.\n\nVERDICT: groomed');
    expect(parsed).toMatchObject({ verdict: 'groomed', notes: undefined });
  });

  it('accepts needs-work spelling variants', () => {
    for (const line of ['VERDICT: needs-work', 'verdict: needs work', 'VERDICT: needs_work']) {
      expect(parseGroomReply(`why\n\n${line}`)).toMatchObject({ verdict: 'needs-work' });
    }
  });

  it('uses the last verdict when the reply deliberates', () => {
    const parsed = parseGroomReply('At first glance:\nVERDICT: groomed\n\nOn reflection, no.\nVERDICT: needs-work');
    expect(parsed).toMatchObject({ verdict: 'needs-work' });
  });

  it('returns null rather than guessing when there is no verdict', () => {
    expect(parseGroomReply('I read the issue and had some thoughts about it.')).toBeNull();
  });

  it('does not mistake prose about a verdict for the verdict line', () => {
    expect(parseGroomReply('I would say VERDICT: groomed is arguable here, but see below.')).toBeNull();
  });
});

describe('force re-grooming', () => {
  const groomed = verdictOn(task(10, 'a'), 'groomed');
  const rejected = verdictOn(task(11, 'b'), 'needs-work');
  const fresh = task(12, 'c');

  it('normally leaves current verdicts alone', () => {
    expect(needsGroom([groomed, rejected, fresh], LABELS).map((t) => t.issueNumber)).toEqual([12]);
  });

  it('revisits current verdicts under force — the fingerprint does not track the principles', () => {
    expect(needsGroom([groomed, rejected, fresh], LABELS, true).map((t) => t.issueNumber)).toEqual([12, 11, 10]);
  });
});
