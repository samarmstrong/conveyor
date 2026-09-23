import { describe, expect, it } from 'vitest';
import { filterAssigned, filterClaimed, filterEpics, parseSelection } from '../src/selector.ts';
import type { Task } from '../src/types.ts';

function task(issueNumber: number, labels: string[] = [], assignees: string[] = []): Task {
  return {
    id: `o/r#${issueNumber}`,
    issueNumber,
    title: `task ${issueNumber}`,
    body: 'some description',
    comments: [],
    labels,
    assignees,
    url: `https://github.com/o/r/issues/${issueNumber}`,
  };
}

const tasks = [task(642), task(693), task(587)];

describe('filterClaimed', () => {
  it('drops issues the factory already claimed', () => {
    const list = [task(1, ['factory:wip']), task(2)];
    expect(filterClaimed(list, 'factory:wip').map((t) => t.issueNumber)).toEqual([2]);
  });
});

describe('parseSelection', () => {
  it('parses the SELECTED marker', () => {
    const s = parseSelection('I looked at all of them.\n\nSELECTED: #642', tasks);
    expect(s).toMatchObject({ kind: 'picked', task: { issueNumber: 642 } });
  });

  it('tolerates spacing and case variants', () => {
    expect(parseSelection('selected: # 693', tasks)).toMatchObject({ kind: 'picked', task: { issueNumber: 693 } });
  });

  it('uses the LAST marker when the reply deliberates', () => {
    const s = parseSelection('Maybe SELECTED: #587? No.\n\nSELECTED: #642', tasks);
    expect(s).toMatchObject({ kind: 'picked', task: { issueNumber: 642 } });
  });

  it('parses SELECTED: none', () => {
    expect(parseSelection('Nothing is well-scoped.\nSELECTED: none', tasks)).toEqual({ kind: 'none' });
  });

  it('falls back to the last candidate issue mentioned when the marker is missing', () => {
    const s = parseSelection('Between #587 and #642, I would go with #642 because it is crisp.', tasks);
    expect(s).toMatchObject({ kind: 'picked', task: { issueNumber: 642 } });
  });

  it('ignores mentions of non-candidate issues', () => {
    const s = parseSelection('This relates to #576 and #520. SELECTED: #642', tasks);
    expect(s).toMatchObject({ kind: 'picked', task: { issueNumber: 642 } });
  });

  it('is unparseable when the marker names a non-candidate', () => {
    expect(parseSelection('SELECTED: #9999', tasks)).toEqual({ kind: 'unparseable' });
  });

  it('is unparseable when nothing matches', () => {
    expect(parseSelection('I could not decide.', tasks)).toEqual({ kind: 'unparseable' });
  });
});

describe('filterEpics', () => {
  it('keeps a groomed epic away from the selector', () => {
    const list = [task(1, ['type:epic', 'factory:groomed']), task(2, ['factory:groomed'])];
    expect(filterEpics(list, 'type:epic').map((t) => t.issueNumber)).toEqual([2]);
  });

  it('filters nothing when no epic label is configured', () => {
    const list = [task(1, ['type:epic'])];
    expect(filterEpics(list, undefined)).toEqual(list);
  });
});

describe('filterAssigned', () => {
  it('drops issues a human has taken', () => {
    const kept = filterAssigned([task(1), task(2, [], ['alice']), task(3)]);
    expect(kept.map((t) => t.issueNumber)).toEqual([1, 3]);
  });

  it('drops an issue with several assignees', () => {
    expect(filterAssigned([task(1, [], ['alice', 'bob'])])).toEqual([]);
  });

  it('keeps everything when nobody is assigned', () => {
    const tasks = [task(1), task(2)];
    expect(filterAssigned(tasks)).toEqual(tasks);
  });
});

describe('oldestFirst', () => {
  const LABELS = { groomed: 'factory:groomed', needsWork: 'factory:needs-work', epic: 'type:epic', blocker: 'factory:blocker' };
  const t = (n: number, labels: string[] = []) => ({ id: `o/r#${n}`, issueNumber: n, title: '', body: '', comments: [], labels, assignees: [], url: '' });

  it('orders groomed issues by number ascending, lowest number first', async () => {
    const { oldestFirst } = await import('../src/controller.ts');
    const input = [t(40), t(7), t(19)];
    expect(oldestFirst(input, LABELS).map((x) => x.issueNumber)).toEqual([7, 19, 40]);
    // Non-mutating: the fetch order is left as GitHub gave it.
    expect(input.map((x) => x.issueNumber)).toEqual([40, 7, 19]);
  });

  it('puts a blocker ahead of everything, however new it is', async () => {
    const { oldestFirst } = await import('../src/controller.ts');
    // The environment pass filed #1080 last night; eighteen groomed issues are older.
    const input = [t(40), t(1080, ['factory:blocker']), t(7), t(900, ['factory:blocker'])];
    expect(oldestFirst(input, LABELS).map((x) => x.issueNumber)).toEqual([900, 1080, 7, 40]);
  });
});

describe('selectorCandidates', () => {
  const LABELS = { groomed: 'factory:groomed', needsWork: 'factory:needs-work', blocker: 'factory:blocker' };
  const t = (n: number, labels: string[] = []) => ({ id: `o/r#${n}`, issueNumber: n, title: '', body: '', comments: [], labels, assignees: [], url: '' });

  it('offers only the blockers while any stand', async () => {
    const { selectorCandidates } = await import('../src/controller.ts');
    expect(selectorCandidates([t(7), t(1080, ['factory:blocker']), t(40)], LABELS).map((x) => x.issueNumber)).toEqual([1080]);
  });

  it('offers the whole groomed set when none does', async () => {
    const { selectorCandidates } = await import('../src/controller.ts');
    expect(selectorCandidates([t(7), t(40)], LABELS).map((x) => x.issueNumber)).toEqual([7, 40]);
  });
});
