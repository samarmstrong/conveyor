import { describe, expect, it } from 'vitest';
import {
  fingerprint, groomComment, groomNotes, groomState, hasLegacyBlock, isEpic, isGroomed, needsGroom, openIssues,
  childrenFiledComment, openChildren, parentEpic, parseGroomReply, premiseOf, readBlocker, readChildren,
  readFingerprint, readPremise, recordFingerprint, stampExtrasFor, stripLegacyBlock, verdict,
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
    assignees: [],
    url: `https://github.com/o/r/issues/${issueNumber}`,
  };
}

const LABELS = { groomed: 'factory:groomed', needsWork: 'factory:needs-work' };

/** The issue as the factory leaves it: its verdict comment, and the matching label. */
function verdictOn(t: Task, v: GroomVerdict, notes?: string, blocked?: number): Task {
  const comment = groomComment(t, {
    verdict: v, notes, reasoning: 'Because of the worker boundary.', children: [],
    ...(blocked !== undefined ? { blocked } : {}),
  });
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

describe('blocked verdicts', () => {
  const blocked = verdictOn(task(20, 'child of the epic'), 'needs-work', undefined, 15);

  it('names the blocker in the stamp and the headline', () => {
    expect(readBlocker(blocked)).toBe(15);
    expect(blocked.comments[0]!.body).toContain('blocked on #15');
    expect(readFingerprint(blocked)).toBe(fingerprint(blocked));
  });

  it('stays current while the blocker is open, and goes stale once it is not', () => {
    const sibling = task(15, 'the sibling');
    expect(groomState(blocked, LABELS, openIssues([sibling, blocked]))).toBe('current');
    expect(groomState(blocked, LABELS, openIssues([blocked]))).toBe('stale');
    expect(needsGroom([blocked], LABELS, false, openIssues([blocked])).map((t) => t.issueNumber)).toEqual([20]);
  });

  it('a groomed sibling is not a landed one; only closing clears it', () => {
    const groomedSibling = verdictOn(task(15, 'the sibling'), 'groomed');
    expect(groomState(blocked, LABELS, openIssues([groomedSibling, blocked]))).toBe('current');
  });

  it('an epic blocker clears when the epic is groomed, since it never closes', () => {
    const EPIC_LABELS = { ...LABELS, epic: 'type:epic' };
    const epic = task(15, 'the epic', [], ['type:epic']);
    expect(groomState(blocked, EPIC_LABELS, openIssues([epic, blocked]))).toBe('current');
    const groomedEpic = verdictOn(epic, 'groomed');
    expect(groomState(blocked, EPIC_LABELS, openIssues([groomedEpic, blocked]))).toBe('stale');
    const rejectedEpic = verdictOn(epic, 'needs-work');
    expect(groomState(blocked, EPIC_LABELS, openIssues([rejectedEpic, blocked]))).toBe('current');
  });

  it('does not consult the blocker when the open set is unknown', () => {
    expect(groomState(blocked, LABELS)).toBe('current');
  });

  it('never stamps a blocker on a groomed verdict', () => {
    const groomed = verdictOn(task(21, 'x'), 'groomed', undefined, 15);
    expect(readBlocker(groomed)).toBeNull();
    expect(groomState(groomed, LABELS, openIssues([groomed]))).toBe('current');
  });

  it('a plain needs-work verdict has no blocker', () => {
    expect(readBlocker(verdictOn(task(22, 'y'), 'needs-work'))).toBeNull();
  });
});

describe('epics', () => {
  const EPIC_LABELS = { ...LABELS, epic: 'type:epic' };
  const epic = task(30, 'Direction: a closed loop', [], ['type:epic']);

  it('grooms ahead of everything else, then newest first', () => {
    const older = task(28, 'a'), newer = task(29, 'b');
    expect(needsGroom([older, newer, epic], EPIC_LABELS).map((t) => t.issueNumber)).toEqual([30, 29, 28]);
    const olderEpic = task(5, 'e', [], ['type:epic']);
    expect(needsGroom([older, newer, olderEpic], EPIC_LABELS).map((t) => t.issueNumber)).toEqual([5, 29, 28]);
  });

  it('is an epic only by the configured label', () => {
    expect(isEpic(epic, EPIC_LABELS)).toBe(true);
    expect(isEpic(task(31, 'z'), EPIC_LABELS)).toBe(false);
    expect(isEpic(epic, LABELS)).toBe(false);
  });

  it('says what a groomed epic means, which is not that an agent can build it', () => {
    const c = groomComment(epic, { verdict: 'groomed', notes: undefined, reasoning: 'Settled: Caldera first.', children: [] }, true);
    expect(c).toContain('epic groomed');
    expect(c).toContain('direction is settled');
    expect(c).not.toContain('An agent can pick this up');
    const n = groomComment(epic, { verdict: 'needs-work', notes: undefined, reasoning: 'Licensing.', children: [] }, true);
    expect(n).toContain('epic needs work');
  });

  it('parses the children the groomer wrote, first line as title', () => {
    const reply = [
      'The direction holds. Decisions: Caldera first (reversal cost: one adapter).',
      '',
      '```child',
      'feat(integrations): Caldera behind an engine-neutral contract',
      '',
      'Part of the loop. Build the slice under core/integrations/caldera/.',
      '```',
      '',
      '```child',
      '## feat(agents): red planning role',
      'Depends on the engine slice landing first.',
      '```',
      '',
      'VERDICT: groomed',
    ].join('\n');
    const parsed = parseGroomReply(reply)!;
    expect(parsed.verdict).toBe('groomed');
    expect(parsed.children).toEqual([
      { title: 'feat(integrations): Caldera behind an engine-neutral contract', body: 'Part of the loop. Build the slice under core/integrations/caldera/.' },
      { title: 'feat(agents): red planning role', body: 'Depends on the engine slice landing first.' },
    ]);
    expect(parsed.reasoning).toContain('Caldera first');
    expect(parsed.reasoning).not.toContain('core/integrations/caldera');
  });

  it('parses a BLOCKED line on a needs-work verdict and ignores one on a groomed verdict', () => {
    expect(parseGroomReply('Waits on the epic.\n\nVERDICT: needs-work\nBLOCKED: #832')).toMatchObject({ verdict: 'needs-work', blocked: 832 });
    expect(parseGroomReply('Waits on the epic.\n\nVERDICT: needs-work\nblocked: 832')).toMatchObject({ blocked: 832 });
    expect(parseGroomReply('Fine.\n\nVERDICT: groomed\nBLOCKED: #832')!.blocked).toBeUndefined();
    expect(parseGroomReply('Fine.\n\nVERDICT: groomed')!.reasoning).not.toContain('BLOCKED');
  });

  it('an ordinary reply has no children', () => {
    expect(parseGroomReply('Clear.\n\nVERDICT: groomed')!.children).toEqual([]);
  });
});

// A child's verdict is judged against its epic's record, and follows it: the
// stamp names the record, and a re-groomed epic makes every child stale.
describe('children of an epic', () => {
  const EPIC_LABELS = { ...LABELS, epic: 'type:epic' };
  const epicGroom = (t: Task, reasoning: string): Task => ({
    ...t,
    comments: [...t.comments, { body: groomComment(t, { verdict: 'groomed', notes: undefined, reasoning, children: [] }, true) }],
    labels: [...t.labels, LABELS.groomed],
  });
  const ungroomedEpic = task(40, 'Direction: a closed loop', [], ['type:epic']);
  const epic = epicGroom(ungroomedEpic, 'Settled: Atomic Red Team first.');
  const child = task(41, 'Part of #40\n\nfeat: the vendor slice');
  const orphan = task(42, 'fix: a typo');

  it('reads the epic a child says it is part of', () => {
    expect(parentEpic(child)).toBe(40);
    expect(parentEpic(orphan)).toBeNull();
    expect(parentEpic(task(43, 'Not really Part of #40 here'))).toBeNull();
  });

  it('names the epic record only when the epic is open and groomed', () => {
    expect(premiseOf(child, EPIC_LABELS, openIssues([epic, child]))).toEqual({ epic: 40, sha: recordFingerprint(epic) });
    expect(premiseOf(child, EPIC_LABELS, openIssues([ungroomedEpic, child]))).toBeNull();
    expect(premiseOf(child, EPIC_LABELS, openIssues([child]))).toBeNull();
    expect(premiseOf(orphan, EPIC_LABELS, openIssues([epic, orphan]))).toBeNull();
    expect(premiseOf(epic, EPIC_LABELS, openIssues([epic]))).toBeNull();
    expect(premiseOf(child, EPIC_LABELS)).toBeNull();
  });

  it('stamps the record into the child verdict and reads it back', () => {
    const premise = premiseOf(child, EPIC_LABELS, openIssues([epic, child]))!;
    const c = groomComment(child, { verdict: 'groomed', notes: undefined, reasoning: 'One PR.', children: [] }, false, { premise });
    expect(c).toContain(`<!-- factory-groom sha=${fingerprint(child)} premise=#40@${premise.sha} -->`);
    const stamped: Task = { ...child, comments: [{ body: c }], labels: [LABELS.groomed] };
    expect(readPremise(stamped)).toEqual(premise);
    expect(readFingerprint(stamped)).toBe(fingerprint(child));
    expect(readBlocker(stamped)).toBeNull();
  });

  it('reads stamp attributes in any order', () => {
    const t: Task = { ...child, comments: [{ body: '<!-- factory-groom premise=#40@abcdef012345 blocked=#39 sha=0123456789ab -->\nverdict' }], labels: [LABELS.needsWork] };
    expect(readFingerprint(t)).toBe('0123456789ab');
    expect(readBlocker(t)).toBe(39);
    expect(readPremise(t)).toEqual({ epic: 40, sha: 'abcdef012345' });
  });

  it('stays current while the epic record stands, and goes stale when the epic is groomed again', () => {
    const premise = premiseOf(child, EPIC_LABELS, openIssues([epic, child]))!;
    const c = groomComment(child, { verdict: 'groomed', notes: undefined, reasoning: 'One PR.', children: [] }, false, { premise });
    const groomedChild: Task = { ...child, comments: [{ body: c }], labels: [LABELS.groomed] };
    expect(groomState(groomedChild, EPIC_LABELS, openIssues([epic, groomedChild]))).toBe('current');

    const regroomed = epicGroom(epic, 'Reply weighed: Caldera first after all.');
    expect(recordFingerprint(regroomed)).not.toBe(premise.sha);
    expect(groomState(groomedChild, EPIC_LABELS, openIssues([regroomed, groomedChild]))).toBe('stale');
    expect(needsGroom([regroomed, groomedChild], EPIC_LABELS, false, openIssues([regroomed, groomedChild])).map((t) => t.issueNumber)).toEqual([41]);
  });

  it('keeps the verdict when the epic has closed, and when the open set is unknown', () => {
    const premise = premiseOf(child, EPIC_LABELS, openIssues([epic, child]))!;
    const c = groomComment(child, { verdict: 'groomed', notes: undefined, reasoning: 'One PR.', children: [] }, false, { premise });
    const groomedChild: Task = { ...child, comments: [{ body: c }], labels: [LABELS.groomed] };
    expect(groomState(groomedChild, EPIC_LABELS, openIssues([groomedChild]))).toBe('current');
    expect(groomState(groomedChild, EPIC_LABELS)).toBe('current');
  });

  it('an epic stamp names its open children, plus the ones the factory files right after', () => {
    const open = openIssues([ungroomedEpic, child, orphan]);
    expect(openChildren(ungroomedEpic, open)).toEqual([41]);
    expect(stampExtrasFor(ungroomedEpic, EPIC_LABELS, open)).toEqual({ children: [41] });
    expect(stampExtrasFor(child, EPIC_LABELS, openIssues([epic, child]))).toEqual({ premise: { epic: 40, sha: recordFingerprint(epic) } });
    expect(stampExtrasFor(child, EPIC_LABELS)).toEqual({});

    const c = groomComment(ungroomedEpic, { verdict: 'groomed', notes: undefined, reasoning: 'Settled.', children: [] }, true, { children: [41] });
    expect(c).toContain('children=#41 -->');
    const filed = childrenFiledComment([{ number: 45, url: 'https://github.com/o/r/issues/45' }]);
    const stamped: Task = { ...ungroomedEpic, comments: [{ body: c }, { body: filed }], labels: ['type:epic', LABELS.groomed] };
    expect(readChildren(stamped)).toEqual([41, 45]);
    // A children-filed comment before the latest stamp belongs to an older verdict.
    const older: Task = { ...stamped, comments: [{ body: filed }, { body: c }] };
    expect(readChildren(older)).toEqual([41]);
  });

  it('an epic goes stale when every child its record knew about has closed — the slice landed', () => {
    const c = groomComment(ungroomedEpic, { verdict: 'groomed', notes: undefined, reasoning: 'Settled.', children: [] }, true, { children: [41] });
    const filed = childrenFiledComment([{ number: 45, url: 'https://github.com/o/r/issues/45' }]);
    const stamped: Task = { ...ungroomedEpic, comments: [{ body: c }, { body: filed }], labels: ['type:epic', LABELS.groomed] };
    const late = task(45, 'Part of #40\n\nfeat: filed by the factory');
    expect(groomState(stamped, EPIC_LABELS, openIssues([stamped, child, late]))).toBe('current');
    expect(groomState(stamped, EPIC_LABELS, openIssues([stamped, late]))).toBe('current');
    expect(groomState(stamped, EPIC_LABELS, openIssues([stamped]))).toBe('stale');
    expect(groomState(stamped, EPIC_LABELS)).toBe('current');
    // An epic that never had children is not waiting on any.
    const childless = groomComment(ungroomedEpic, { verdict: 'groomed', notes: undefined, reasoning: 'Settled.', children: [] }, true, { children: [] });
    const lone: Task = { ...ungroomedEpic, comments: [{ body: childless }], labels: ['type:epic', LABELS.groomed] };
    expect(groomState(lone, EPIC_LABELS, openIssues([lone]))).toBe('current');
  });

  it('waits for the epic: a child is not groomed in a tick where its epic still needs one', () => {
    const sibling = task(44, 'Part of #40\n\nfeat: reconstruction');
    expect(needsGroom([ungroomedEpic, child, sibling, orphan], EPIC_LABELS).map((t) => t.issueNumber)).toEqual([40, 42]);
    expect(needsGroom([epic, child, sibling, orphan], EPIC_LABELS).map((t) => t.issueNumber)).toEqual([44, 42, 41]);
    // Under force the epic is pending again, so its children wait for the next tick.
    expect(needsGroom([epic, child, orphan], EPIC_LABELS, true).map((t) => t.issueNumber)).toEqual([40, 42]);
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
