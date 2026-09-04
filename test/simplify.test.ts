import { describe, expect, it } from 'vitest';
import { declinedSimplifications, recentlyMergedFactoryPrs, shrinks, skipReason } from '../src/simplify.ts';
import type { OutcomeRecord, SimplifyRecord } from '../src/types.ts';

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

function outcome(prUrl: string, over: Partial<OutcomeRecord> = {}): OutcomeRecord {
  return {
    type: 'outcome',
    prUrl,
    source: 'implementer',
    issueNumber: 1,
    merged: true,
    closedAt: '2026-01-02T00:00:00Z',
    humanChangeRequests: 0,
    humanCommentCount: 0,
    recordedAt: '2026-01-02T00:00:00Z',
    ...over,
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
  it('recently merged implementer PRs, newest first, capped', () => {
    const outcomes = [
      outcome(pr(1), { closedAt: '2026-01-01T00:00:00Z' }),
      outcome(pr(3), { closedAt: '2026-03-01T00:00:00Z' }),
      outcome(pr(2), { closedAt: '2026-02-01T00:00:00Z' }),
      outcome(pr(4), { closedAt: '2026-04-01T00:00:00Z', merged: false }),
      outcome(pr(5), { closedAt: '2026-05-01T00:00:00Z', source: 'environment' }),
      outcome(pr(6), { closedAt: '2026-06-01T00:00:00Z', source: 'simplify' }),
    ];
    expect(recentlyMergedFactoryPrs(outcomes, 2)).toEqual([pr(3), pr(2)]);
  });

  it('treats a record with no source as an implementer PR', () => {
    const legacy = outcome(pr(1));
    delete legacy.source;
    expect(recentlyMergedFactoryPrs([legacy], 5)).toEqual([pr(1)]);
  });

  it('declined simplifications are the unmerged simplify outcomes', () => {
    const outcomes = [
      outcome(pr(1), { source: 'simplify', merged: false }),
      outcome(pr(2), { source: 'simplify' }),
      outcome(pr(3), { merged: false }),
    ];
    expect(declinedSimplifications(outcomes)).toEqual([pr(1)]);
  });
});
