import { describe, expect, it } from 'vitest';
import {
  fingerprint, groomComment, groomNotes, groomState, hasLegacyBlock, isDraft, isEpic, isFactoryComment, isGroomed, needsGroom, openIssues,
  childDroppedComment, childrenFiledComment, epicRecognizedComment, openChildren, parentEpic, parseGroomReply, premiseOf, readBlocker, readChildren,
  readFingerprint, readPremise, recordFingerprint, settlesDirection, stampExtrasFor, stripLegacyBlock, unaccountedBlockers, verdict,
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

  it('grooms the ungroomed and the stale, oldest first', () => {
    expect(needsGroom([groomed, rejected, fresh, stale], LABELS).map((t) => t.issueNumber)).toEqual([9, 12]);
  });

  it('grooms a blocker ahead of the backlog, and an epic ahead of that', () => {
    const blocker = task(1080, 'test db empty', [], ['factory:blocker']);
    const epic = task(2000, 'a direction', [], ['type:epic']);
    const labels = { ...LABELS, epic: 'type:epic', blocker: 'factory:blocker' };
    expect(needsGroom([fresh, blocker, stale, epic], labels).map((t) => t.issueNumber)).toEqual([2000, 1080, 9, 12]);
  });

  it('offers every issue carrying the groomed label for implementation', () => {
    expect([groomed, rejected, fresh, stale].filter((t) => isGroomed(t, LABELS)).map((t) => t.issueNumber)).toEqual([10, 9]);
  });

  it('holds the children of a draft epic: their premise is still being written', () => {
    const labels = { ...LABELS, epic: 'type:epic', draft: 'factory:draft' };
    const draftEpic = task(100, 'a direction, half written', [], ['type:epic', 'factory:draft']);
    const child = task(101, 'Part of #100\n\nfirst slice');
    const unrelated = task(102, 'Part of #99\n\nanother epic');
    expect(isDraft(draftEpic, labels)).toBe(true);
    expect(isDraft(child, labels)).toBe(false);
    // The draft itself never reaches needsGroom — admission filters it — but
    // it is in the open set, which is where its children find it.
    const open = openIssues([draftEpic, child, unrelated]);
    expect(needsGroom([child, unrelated], labels, false, open).map((t) => t.issueNumber)).toEqual([102]);
    // The label comes off: the epic is groomed, and the child waits for that groom as any child does.
    const epic = { ...draftEpic, labels: ['type:epic'] };
    expect(needsGroom([epic, child, unrelated], labels, false, openIssues([epic, child, unrelated])).map((t) => t.issueNumber)).toEqual([100, 102]);
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

  it('parses the epic verdict: a direction, not a PR', () => {
    const parsed = parseGroomReply('Three phases, each several PRs, with decisions that bind them.\n\nVERDICT: epic');
    expect(parsed).toMatchObject({ verdict: 'epic' });
    expect(parsed!.reasoning).not.toContain('VERDICT');
  });
});

describe('recognising an epic', () => {
  it('the comment is a factory comment, not a groom stamp, and names the label', () => {
    const c = epicRecognizedComment('Several PRs, one direction.', 'type:epic');
    expect(isFactoryComment(c)).toBe(true);
    expect(c).not.toMatch(/factory-groom sha=/);
    expect(c).toContain('`type:epic`');
    expect(c).toContain('Several PRs, one direction.');
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

  it('a blocker that is not an open issue but is held open — a PR in flight — has not cleared', () => {
    // #15 is a pull request: never in the issue list, so absent from the map.
    expect(groomState(blocked, LABELS, openIssues([blocked], [15]))).toBe('current');
    expect(groomState(blocked, LABELS, openIssues([blocked], []))).toBe('stale');
    expect(needsGroom([blocked], LABELS, false, openIssues([blocked], [15]))).toEqual([]);
  });

  it('names the blockers the open issues do not account for, once each', () => {
    const sibling = task(15, 'the sibling');
    const alsoBlocked = verdictOn(task(21, 'another child'), 'needs-work', undefined, 15);
    const onPr = verdictOn(task(22, 'waits on a PR'), 'needs-work', undefined, 913);
    const unblocked = verdictOn(task(23, 'fine'), 'groomed');
    expect(unaccountedBlockers([blocked, alsoBlocked, onPr, unblocked, sibling], openIssues([blocked, alsoBlocked, onPr, unblocked, sibling]))).toEqual([913]);
    expect(unaccountedBlockers([blocked, alsoBlocked, onPr], openIssues([blocked, alsoBlocked, onPr]))).toEqual([15, 913]);
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

  it('grooms ahead of everything else, then oldest first', () => {
    const older = task(28, 'a'), newer = task(29, 'b');
    expect(needsGroom([older, newer, epic], EPIC_LABELS).map((t) => t.issueNumber)).toEqual([30, 28, 29]);
    const olderEpic = task(5, 'e', [], ['type:epic']);
    expect(needsGroom([older, newer, olderEpic], EPIC_LABELS).map((t) => t.issueNumber)).toEqual([5, 28, 29]);
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

  // Settling a direction is the judgment worth the stronger model; the
  // re-reviews the factory's own bookkeeping brings back only track the work.
  it('settles the direction until an epic record stands, and again once a human replies', () => {
    const asEpic = (t: Task, v: GroomVerdict): Task => ({
      ...t,
      comments: [...t.comments, { body: groomComment(t, { verdict: v, notes: undefined, reasoning: 'Settled.', children: [] }, true) }],
      labels: [...t.labels, v === 'groomed' ? LABELS.groomed : LABELS.needsWork],
    });
    expect(settlesDirection(epic, EPIC_LABELS)).toBe(true);
    expect(settlesDirection(asEpic(epic, 'needs-work'), EPIC_LABELS)).toBe(true);
    const groomed = asEpic(epic, 'groomed');
    expect(settlesDirection(groomed, EPIC_LABELS)).toBe(false);
    expect(settlesDirection({ ...groomed, comments: [...groomed.comments, { body: 'Cut the second screen.' }] }, EPIC_LABELS)).toBe(true);
    // Groomed as one PR, then found to be an epic: no epic record yet.
    const promoted = { ...verdictOn(task(32, 'One PR?'), 'groomed'), labels: [LABELS.groomed, 'type:epic'] };
    expect(settlesDirection(promoted, EPIC_LABELS)).toBe(true);
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

  it('an epic goes stale when the children still open were groomed needs-work — they are its to weigh', () => {
    const c = groomComment(ungroomedEpic, { verdict: 'groomed', notes: undefined, reasoning: 'Settled.', children: [] }, true, { children: [41, 44] });
    const stamped: Task = { ...ungroomedEpic, comments: [{ body: c }], labels: ['type:epic', LABELS.groomed] };
    const rejected = verdictOn(child, 'needs-work');
    const sibling = task(44, 'Part of #40\n\nfeat: reconstruction');
    expect(groomState(stamped, EPIC_LABELS, openIssues([stamped, rejected, sibling]))).toBe('current');
    expect(groomState(stamped, EPIC_LABELS, openIssues([stamped, rejected]))).toBe('stale');

    // The re-groom names the needs-work child as weighed: still needs-work, it does not bring the epic back…
    const extras = stampExtrasFor(stamped, EPIC_LABELS, openIssues([stamped, rejected]));
    expect(extras).toEqual({ children: [41], weighed: [41] });
    const regroomed: Task = { ...stamped, comments: [...stamped.comments, { body: groomComment(stamped, { verdict: 'groomed', notes: undefined, reasoning: 'Record corrected for #41.', children: [] }, true, extras) }] };
    expect(regroomed.comments.at(-1)!.body).toContain('children=#41 weighed=#41 -->');
    expect(groomState(regroomed, EPIC_LABELS, openIssues([regroomed, verdictOn(child, 'needs-work')]))).toBe('current');
    // …re-groomed against the corrected record it is in flight, and when it lands the epic comes back.
    expect(groomState(regroomed, EPIC_LABELS, openIssues([regroomed, verdictOn(child, 'groomed')]))).toBe('current');
    expect(groomState(regroomed, EPIC_LABELS, openIssues([regroomed]))).toBe('stale');
  });

  it('an epic waits while a needs-work child blocked on a sibling that landed is groomed again on its own', () => {
    const c = groomComment(ungroomedEpic, { verdict: 'groomed', notes: undefined, reasoning: 'Settled.', children: [] }, true, { children: [41, 44] });
    const stamped: Task = { ...ungroomedEpic, comments: [{ body: c }], labels: ['type:epic', LABELS.groomed] };
    const blocked = verdictOn(child, 'needs-work', undefined, 44);
    const sibling = task(44, 'Part of #40\n\nfeat: reconstruction');
    expect(groomState(stamped, EPIC_LABELS, openIssues([stamped, blocked, sibling]))).toBe('current');
    // #44 lands: #41's wait is over, and #41 — not the epic — is what gets groomed.
    const open = openIssues([stamped, blocked]);
    expect(groomState(blocked, EPIC_LABELS, open)).toBe('stale');
    expect(groomState(stamped, EPIC_LABELS, open)).toBe('current');
    expect(needsGroom([stamped, blocked], EPIC_LABELS, false, open).map((t) => t.issueNumber)).toEqual([41]);
    // Re-groomed needs-work with nothing left to wait on, it is the epic's to weigh.
    expect(groomState(stamped, EPIC_LABELS, openIssues([stamped, verdictOn(child, 'needs-work')]))).toBe('stale');
  });

  it('an epic holding work back for something outside its slice comes back when that closes', () => {
    const reply = parseGroomReply('Settled. The tour waits on the Home route.\n\nVERDICT: groomed\nWAITING: #50\nwaiting: 51\nWAITING: #50')!;
    expect(reply.waiting).toEqual([50, 51]);
    expect(reply.reasoning).not.toContain('WAITING');
    const c = groomComment(ungroomedEpic, reply, true, { children: [41] });
    expect(c).toContain('children=#41 waiting=#50,#51 -->');
    const stamped: Task = { ...ungroomedEpic, comments: [{ body: c }], labels: ['type:epic', LABELS.groomed] };
    const home = task(50, 'feat: Home route');
    const pr = 51;
    // While the slice is in flight and both waits are open, nothing to do.
    expect(groomState(stamped, EPIC_LABELS, openIssues([stamped, child, home], [pr]))).toBe('current');
    // A PR not among the open issues is looked up, not read as closed.
    expect(unaccountedBlockers([stamped], openIssues([stamped, child, home]))).toEqual([51]);
    // Either one closing brings the epic back, even with its own slice still open.
    expect(groomState(stamped, EPIC_LABELS, openIssues([stamped, child], [pr]))).toBe('stale');
    expect(groomState(stamped, EPIC_LABELS, openIssues([stamped, child, home]))).toBe('stale');
  });

  it('only a groomed epic waits: the line is ignored on a child or a needs-work epic', () => {
    const reply = parseGroomReply('Blocked.\n\nVERDICT: needs-work\nWAITING: #50')!;
    expect(groomComment(ungroomedEpic, reply, true)).not.toContain('waiting=');
    const groomed = parseGroomReply('One PR.\n\nVERDICT: groomed\nWAITING: #50')!;
    expect(groomComment(child, groomed)).not.toContain('waiting=');
  });

  it('parses and publishes done, the epic delivered', () => {
    expect(parseGroomReply('Every decision landed.\n\nVERDICT: done')).toMatchObject({ verdict: 'done' });
    const c = groomComment(ungroomedEpic, { verdict: 'done', notes: undefined, reasoning: 'Every decision landed.', children: [] }, true);
    expect(c).toContain('epic done');
    expect(c).toContain('Reopen it');
    expect(c).not.toContain('reviewed again on a later tick');
    expect(childDroppedComment(ungroomedEpic)).toContain('let go by #40');
  });

  it('parses and publishes close, an issue with nothing to build', () => {
    expect(parseGroomReply('Already true at core/x.py.\n\nVERDICT: close')).toMatchObject({ verdict: 'close' });
    const c = groomComment(child, { verdict: 'close', notes: undefined, reasoning: 'Already true.', children: [] });
    expect(c).toContain('Factory groom — closed.');
    expect(c).toContain('Reopen it');
  });

  it('parses the needs-work children an epic groom lets go, and keeps them out of the comment', () => {
    const parsed = parseGroomReply('#834 is the split #837 replaced.\n\nVERDICT: groomed\nCLOSE: #834\nclose: 907\nCLOSE: #834')!;
    expect(parsed.close).toEqual([834, 907]);
    expect(parsed.reasoning).not.toContain('CLOSE');
    expect(parseGroomReply('Clear.\n\nVERDICT: groomed')!.close).toBeUndefined();
  });

  it('waits for the epic: a child is not groomed in a tick where its epic still needs one', () => {
    const sibling = task(44, 'Part of #40\n\nfeat: reconstruction');
    expect(needsGroom([ungroomedEpic, child, sibling, orphan], EPIC_LABELS).map((t) => t.issueNumber)).toEqual([40, 42]);
    expect(needsGroom([epic, child, sibling, orphan], EPIC_LABELS).map((t) => t.issueNumber)).toEqual([41, 42, 44]);
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
    expect(needsGroom([groomed, rejected, fresh], LABELS, true).map((t) => t.issueNumber)).toEqual([10, 11, 12]);
  });
});
