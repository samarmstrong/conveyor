import { describe, expect, it } from 'vitest';
import { leakedClaims, unrecordedOutcomes, withSource, type SourcedPr } from '../src/outcomes.ts';
import type { PrData } from '../src/github.ts';

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

describe('leakedClaims', () => {
  const claimed = [{ number: 1 }, { number: 2 }, { number: 3 }];

  it('releases issues no open PR links and no pipeline is running', () => {
    expect(leakedClaims(claimed, [{ body: 'Closes #1' }], [{ issueNumber: 2 }])).toEqual([3]);
  });

  it('releases everything when nothing is in flight anywhere', () => {
    expect(leakedClaims(claimed, [], [])).toEqual([1, 2, 3]);
  });

  it('releases nothing when nothing is claimed', () => {
    expect(leakedClaims([], [{ body: 'Closes #1' }], [])).toEqual([]);
  });
});
