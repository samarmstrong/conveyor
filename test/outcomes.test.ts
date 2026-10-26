import { describe, expect, it } from 'vitest';
import { leakedClaims, pastGrace, spentVerdicts, unheldClaims, unrecordedOutcomes, withSource, type SourcedPr } from '../src/outcomes.ts';
import type { LabelHistory, PrData } from '../src/github.ts';

const url = (n: number) => `https://github.com/o/r/pull/${n}`;

function pr(n: number, state: PrData['state'], over: Partial<PrData> = {}): PrData {
  return {
    number: n, url: url(n), title: `pr ${n}`, state, isDraft: false, createdAt: '2026-01-01T00:00:00Z',
    mergedAt: state === 'MERGED' ? '2026-01-02T00:00:00Z' : null,
    closedAt: state === 'OPEN' ? null : '2026-01-02T00:00:00Z',
    body: '', reviews: [], comments: [], headRefName: `b${n}`, additions: 1, deletions: 1, ...over,
  };
}

describe('unrecordedOutcomes', () => {
  it('writes one row per closed PR not already in the record, open ones excluded', () => {
    const prs: SourcedPr[] = withSource([pr(1, 'MERGED'), pr(2, 'CLOSED'), pr(3, 'OPEN')], 'implementer');
    const rows = unrecordedOutcomes(prs, new Set([url(2)]), 'now');
    expect(rows.map((r) => r.prUrl)).toEqual([url(1)]);
    expect(rows[0]).toMatchObject({ source: 'implementer', merged: true, closedAt: '2026-01-02T00:00:00Z', recordedAt: 'now' });
  });

  it('links an implementer PR to its issue and an environment PR to none', () => {
    const rows = unrecordedOutcomes([
      ...withSource([pr(1, 'MERGED', { body: 'Closes #12' })], 'implementer'),
      ...withSource([pr(2, 'MERGED', { body: 'Closes #12' })], 'environment'),
    ], new Set());
    expect(rows.map((r) => r.issueNumber)).toEqual([12, null]);
  });

  it('counts human change requests and comments', () => {
    const reviews = [{ state: 'CHANGES_REQUESTED' }, { state: 'APPROVED' }, { state: 'CHANGES_REQUESTED' }];
    const comments = [{ author: { login: 'a' }, body: '', url: '' }];
    const [row] = unrecordedOutcomes(withSource([pr(1, 'CLOSED', { reviews, comments })], 'simplify'), new Set());
    expect(row).toMatchObject({ humanChangeRequests: 2, humanCommentCount: 1, merged: false });
  });

  it('names a PR once even if GitHub lists it under two labels', () => {
    const rows = unrecordedOutcomes([...withSource([pr(1, 'MERGED')], 'implementer'), ...withSource([pr(1, 'MERGED')], 'simplify')], new Set());
    expect(rows).toHaveLength(1);
  });
});

describe('unheldClaims', () => {
  const claimed = [{ number: 1 }, { number: 2 }, { number: 3 }];

  it('leaves out issues an open PR links or a pipeline here is running', () => {
    expect(unheldClaims(claimed, [{ body: 'Closes #1' }], [{ issueNumber: 2 }])).toEqual([3]);
  });

  it('is every claim when nothing is in flight here', () => {
    expect(unheldClaims(claimed, [], [])).toEqual([1, 2, 3]);
  });

  it('is nothing when nothing is claimed', () => {
    expect(unheldClaims([], [{ body: 'Closes #1' }], [])).toEqual([]);
  });
});

describe('leakedClaims', () => {
  const now = Date.parse('2026-10-14T12:00:00Z');
  const day = 24 * 3_600_000;
  const claimedAt = (iso: string) => ({ labelledAt: { 'factory:wip': iso } });

  it('holds a claim another runner may still be working under, and releases it once older than the bound', () => {
    // Oct 14: an Actions tick released #2269 and #2270 an hour into a local tick's build.
    const history = new Map([[2269, claimedAt('2026-10-14T11:00:00Z')], [2270, claimedAt('2026-10-13T11:00:00Z')]]);
    expect(leakedClaims([2269, 2270], history, [], 'factory:wip', day, now)).toEqual([2270]);
  });

  it('releases at once a claim whose factory PR has closed since it was made, but not for an older PR', () => {
    const history = new Map([[1, claimedAt('2026-10-14T09:00:00Z')], [2, claimedAt('2026-10-14T09:00:00Z')]]);
    const closed = [
      { body: 'Closes #1', closedAt: '2026-10-14T11:00:00Z', mergedAt: null },
      { body: 'Closes #2', closedAt: '2026-10-10T00:00:00Z', mergedAt: '2026-10-10T00:00:00Z' },
    ];
    expect(leakedClaims([1, 2], history, closed, 'factory:wip', day, now)).toEqual([1]);
  });

  it('holds an issue whose history could not be read, and releases one whose timeline shows no claim', () => {
    expect(leakedClaims([1, 2], new Map([[2, { labelledAt: {} }]]), [], 'factory:wip', day, now)).toEqual([2]);
  });
});

describe('spentVerdicts', () => {
  const labels = { groomed: 'factory:groomed', epic: 'type:epic' };
  const merged = (n: number, body: string) => pr(n, 'MERGED', { body, mergedAt: '2026-10-07T00:00:00Z' });
  const issue = (groomedAt: string, over: Partial<LabelHistory> = {}): LabelHistory =>
    ({ open: true, labels: ['factory:groomed'], labelledAt: { 'factory:groomed': groomedAt }, ...over });

  it('spends a verdict put on before a merged PR that left its issue open (#1712 after #1775)', () => {
    const history = new Map([[1712, issue('2026-10-06T00:00:00Z')]]);
    expect(spentVerdicts([merged(1775, 'Part of #1712 (not "Closes")')], history, labels)).toEqual([{ issue: 1712, prUrl: url(1775) }]);
  });

  it('keeps a verdict put on after the merge: that is the groom of the remainder', () => {
    const history = new Map([[1712, issue('2026-10-08T00:00:00Z')]]);
    expect(spentVerdicts([merged(1775, 'Part of #1712')], history, labels)).toEqual([]);
  });

  it('leaves alone a closed issue, a needs-work one, an epic, an open PR, and an issue it could not read', () => {
    const history = new Map([
      [1, issue('2026-10-06T00:00:00Z', { open: false })],
      [2, issue('2026-10-06T00:00:00Z', { labels: ['factory:needs-work'] })],
      [3, issue('2026-10-06T00:00:00Z', { labels: ['factory:groomed', 'type:epic'] })],
      [4, issue('2026-10-06T00:00:00Z')],
    ]);
    const prs = [merged(11, 'Closes #1'), merged(12, 'Part of #2'), merged(13, 'Part of #3'), pr(14, 'OPEN', { body: 'Part of #4' }), merged(15, 'Part of #5')];
    expect(spentVerdicts(prs, history, labels)).toEqual([]);
  });

  it('spends a verdict once however many merged PRs it built', () => {
    const history = new Map([[7, issue('2026-10-06T00:00:00Z')]]);
    expect(spentVerdicts([merged(20, 'Part of #7'), merged(21, 'Part of #7')], history, labels)).toHaveLength(1);
  });
});

describe('pastGrace', () => {
  const now = Date.parse('2026-10-14T12:00:00Z');
  it('is false for a PR younger than the grace, true for an older one', () => {
    expect(pastGrace({ createdAt: '2026-10-14T11:30:00Z' }, 2 * 3_600_000, now)).toBe(false);
    expect(pastGrace({ createdAt: '2026-10-14T09:00:00Z' }, 2 * 3_600_000, now)).toBe(true);
  });
});
