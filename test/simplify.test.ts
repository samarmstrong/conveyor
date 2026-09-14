import { describe, expect, it } from 'vitest';
import { declinedSimplifications, recentlyMergedFactoryPrs, shrinks, skipReason } from '../src/simplify.ts';
import type { SimplifyRecord } from '../src/types.ts';

const pr = (n: number) => `https://github.com/o/r/pull/${n}`;

function pass(outcome: SimplifyRecord['outcome'], baseSha = 'aaaaaaaa', prUrl: string | null = null): SimplifyRecord {
  return {
    type: 'simplify',
    baseSha,
    outcome,
    prUrl,
    worker: 'cursor',
    model: null,
    agentId: 'agent-simplify',
    startedAt: '2026-01-02T00:00:00Z',
    finishedAt: '2026-01-02T00:00:00Z',
    usage: null,
    durationMs: 1,
  };
}

describe('skipReason', () => {
  it('runs when enabled, nothing is open, and no pass has seen this commit', () => {
    expect(skipReason(true, [], [pass('no-change', 'old')], 'new')).toBeNull();
  });

  it('skips when disabled', () => {
    expect(skipReason(false, [], [], 'new')).toMatch(/disabled/);
  });

  it('skips while a simplification PR awaits a human, naming it', () => {
    expect(skipReason(true, [{ url: pr(20) }], [], 'new')).toContain(pr(20));
  });

  it('does not repeat a pass that reached a conclusion on the same commit', () => {
    for (const concluded of ['no-change', 'grew', 'pr-opened'] as const) {
      expect(skipReason(true, [], [pass(concluded, 'same')], 'same')).toMatch(/has not changed/);
    }
  });

  it('retries a failed pass on the same commit', () => {
    expect(skipReason(true, [], [pass('failed', 'same')], 'same')).toBeNull();
  });

  it('judges by the latest pass only', () => {
    expect(skipReason(true, [], [pass('no-change', 'same'), pass('failed', 'same')], 'same')).toBeNull();
  });
});

describe('shrinks', () => {
  it('requires strictly more deletions than additions', () => {
    expect(shrinks({ additions: 10, deletions: 11 })).toBe(true);
    expect(shrinks({ additions: 10, deletions: 10 })).toBe(false);
  });
});

describe('what the agent is pointed at', () => {
  const merged = (n: number, mergedAt: string | null) => ({ url: pr(n), mergedAt });

  it('recently merged implementer PRs, newest first, capped, however GitHub orders them', () => {
    const prs = [merged(1, '2026-01-01T00:00:00Z'), merged(3, '2026-03-01T00:00:00Z'), merged(2, '2026-02-01T00:00:00Z'), merged(4, null)];
    expect(recentlyMergedFactoryPrs(prs, 2)).toEqual([pr(3), pr(2)]);
  });

  const closed = (n: number, state: string, additions: number, deletions: number) => ({ url: pr(n), state, additions, deletions });

  it('declined simplifications are the closed ones a human could have merged', () => {
    const prs = [
      closed(1, 'CLOSED', 3, 40), // a human declined this
      closed(2, 'MERGED', 3, 40),
      closed(3, 'OPEN', 3, 40),
      closed(4, 'CLOSED', 40, 3), // grew: the factory closed it, not a human
    ];
    expect(declinedSimplifications(prs)).toEqual([pr(1)]);
  });
});
