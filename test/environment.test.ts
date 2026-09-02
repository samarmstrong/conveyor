import { describe, expect, it } from 'vitest';
import { environmentChangedAt, skipReason, unreadFactoryPrs, type UnreadPrs } from '../src/environment.ts';
import type { EnvRecord, OutcomeRecord, RunRecord } from '../src/types.ts';

function run(issueNumber: number, prUrl: string | null, startedAt = '2026-01-02T00:00:00Z', over: Partial<RunRecord> = {}): RunRecord {
  return {
    type: 'run',
    taskId: `o/r#${issueNumber}`,
    issueNumber,
    issueTitle: `issue ${issueNumber}`,
    worker: 'cursor',
    model: null,
    agentId: `agent-${issueNumber}`,
    startedAt,
    finishedAt: startedAt,
    outcome: prUrl ? 'pr-opened' : 'no-pr',
    prUrl,
    usage: null,
    durationMs: 1,
    ...over,
  };
}

function pass(prsExamined: string[], over: Partial<EnvRecord> = {}): EnvRecord {
  return {
    type: 'env',
    prsExamined,
    outcome: 'no-gap',
    prUrl: null,
    worker: 'cursor',
    model: null,
    agentId: 'agent-env',
    startedAt: '2026-01-02T00:00:00Z',
    finishedAt: '2026-01-02T00:00:00Z',
    usage: null,
    durationMs: 1,
    ...over,
  };
}

function outcome(prUrl: string, over: Partial<OutcomeRecord> = {}): OutcomeRecord {
  return {
    type: 'outcome',
    prUrl,
    source: 'environment',
    issueNumber: null,
    merged: true,
    closedAt: '2026-01-02T00:00:00Z',
    humanChangeRequests: 0,
    humanCommentCount: 0,
    recordedAt: '2026-01-02T00:00:00Z',
    ...over,
  };
}

const pr = (n: number) => `https://github.com/o/r/pull/${n}`;
const unread = (fresh: string[] = [], stale: string[] = []): UnreadPrs => ({ fresh, stale });

describe('environmentChangedAt', () => {
  it('is null before any environment PR has merged', () => {
    expect(environmentChangedAt([])).toBeNull();
    expect(environmentChangedAt([outcome(pr(1), { merged: false })])).toBeNull();
  });

  it('ignores implementer PRs, however recent', () => {
    const recent = outcome(pr(9), { source: 'implementer', closedAt: '2026-06-01T00:00:00Z' });
    expect(environmentChangedAt([recent])).toBeNull();
  });

  it('takes the latest merge, not the last record written', () => {
    const older = outcome(pr(1), { closedAt: '2026-03-01T00:00:00Z' });
    const newer = outcome(pr(2), { closedAt: '2026-05-01T00:00:00Z' });
    expect(environmentChangedAt([newer, older])).toBe('2026-05-01T00:00:00Z');
  });

  it('ignores an environment PR that was closed unmerged', () => {
    const merged = outcome(pr(1), { closedAt: '2026-03-01T00:00:00Z' });
    const rejected = outcome(pr(2), { merged: false, closedAt: '2026-05-01T00:00:00Z' });
    expect(environmentChangedAt([merged, rejected])).toBe('2026-03-01T00:00:00Z');
  });
});

describe('unreadFactoryPrs', () => {
  it('returns the PRs no pass has read, newest first', () => {
    const got = unreadFactoryPrs([run(1, pr(11)), run(2, pr(12))], [], null);
    expect(got).toEqual(unread([pr(12), pr(11)]));
  });

  it('skips runs that opened no PR', () => {
    expect(unreadFactoryPrs([run(1, null), run(2, pr(12))], [], null).fresh).toEqual([pr(12)]);
  });

  it('drops PRs a previous pass already read', () => {
    const runs = [run(1, pr(11)), run(2, pr(12)), run(3, pr(13))];
    expect(unreadFactoryPrs(runs, [pass([pr(13)]), pass([pr(12)])], null).fresh).toEqual([pr(11)]);
  });

  it('names a PR once even when several run records point at it', () => {
    // A pipeline that failed after opening its PR writes a second record.
    const runs = [run(1, pr(11)), run(1, pr(11), '2026-01-02T00:00:00Z', { outcome: 'failed' })];
    expect(unreadFactoryPrs(runs, [], null).fresh).toEqual([pr(11)]);
  });

  it('re-offers the PRs of a pass that failed before reaching a conclusion', () => {
    const failed = pass([], { outcome: 'failed', failureReason: 'run ended with status ERROR' });
    expect(unreadFactoryPrs([run(1, pr(11))], [failed], null).fresh).toEqual([pr(11)]);
  });

  it('calls a report stale when its run started before the environment changed', () => {
    // PR 781's story: the reports were all written on the pre-Docker machine.
    const runs = [run(1, pr(765), '2026-08-31T18:48:00Z'), run(2, pr(782), '2026-09-01T18:56:00Z')];
    expect(unreadFactoryPrs(runs, [], '2026-09-01T19:35:51Z')).toEqual(unread([], [pr(782), pr(765)]));
  });

  it('keeps a report from a run that started after the change', () => {
    const runs = [run(1, pr(782), '2026-09-01T18:56:00Z'), run(2, pr(790), '2026-09-01T20:00:00Z')];
    expect(unreadFactoryPrs(runs, [], '2026-09-01T19:35:51Z')).toEqual(unread([pr(790)], [pr(782)]));
  });

  it('treats everything as fresh when no environment PR has ever merged', () => {
    const runs = [run(1, pr(765), '2020-01-01T00:00:00Z')];
    expect(unreadFactoryPrs(runs, [], null).fresh).toEqual([pr(765)]);
  });
});

describe('skipReason', () => {
  it('runs when enabled, nothing is open, and there is a fresh report', () => {
    expect(skipReason(true, [], unread([pr(11)]))).toBeNull();
  });

  it('skips when disabled', () => {
    expect(skipReason(false, [], unread([pr(11)]))).toMatch(/disabled/);
  });

  it('skips while an environment PR is still awaiting a human, naming it', () => {
    const reason = skipReason(true, [{ url: pr(20) }], unread([pr(11)]));
    expect(reason).toMatch(/already awaiting a human/);
    expect(reason).toContain(pr(20));
  });

  it('skips when every factory PR has already been read', () => {
    expect(skipReason(true, [], unread())).toMatch(/not already read/);
  });

  it('skips, naming the cutoff, when the only unread reports predate the change', () => {
    const reason = skipReason(true, [], unread([], [pr(782), pr(765)]), '2026-09-01T19:35:51Z');
    expect(reason).toMatch(/2 unread factory PR\(s\)/);
    expect(reason).toContain('2026-09-01T19:35:51Z');
  });

  it('runs on the fresh reports even when stale ones are also pending', () => {
    expect(skipReason(true, [], unread([pr(790)], [pr(782)]), '2026-09-01T19:35:51Z')).toBeNull();
  });

  it('reports the open PR before anything else when both apply', () => {
    expect(skipReason(true, [{ url: pr(20) }], unread())).toMatch(/already awaiting a human/);
  });
});
