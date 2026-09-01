import { describe, expect, it } from 'vitest';
import { skipReason, unexaminedPrUrls } from '../src/environment.ts';
import type { EnvRecord, RunRecord } from '../src/types.ts';

function run(issueNumber: number, prUrl: string | null, over: Partial<RunRecord> = {}): RunRecord {
  return {
    type: 'run',
    taskId: `o/r#${issueNumber}`,
    issueNumber,
    issueTitle: `issue ${issueNumber}`,
    worker: 'cursor',
    model: null,
    agentId: `agent-${issueNumber}`,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
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
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    usage: null,
    durationMs: 1,
    ...over,
  };
}

const pr = (n: number) => `https://github.com/o/r/pull/${n}`;

describe('unexaminedPrUrls', () => {
  it('returns the factory PRs no pass has read, newest first', () => {
    const urls = unexaminedPrUrls([run(1, pr(11)), run(2, pr(12))], []);
    expect(urls).toEqual([pr(12), pr(11)]);
  });

  it('skips runs that opened no PR', () => {
    expect(unexaminedPrUrls([run(1, null), run(2, pr(12))], [])).toEqual([pr(12)]);
  });

  it('drops PRs a previous pass already read', () => {
    const runs = [run(1, pr(11)), run(2, pr(12)), run(3, pr(13))];
    const passes = [pass([pr(13)]), pass([pr(12)])];
    expect(unexaminedPrUrls(runs, passes)).toEqual([pr(11)]);
  });

  it('names a PR once even when several run records point at it', () => {
    // A pipeline that failed after opening its PR writes a second record.
    const runs = [run(1, pr(11)), run(1, pr(11), { outcome: 'failed' })];
    expect(unexaminedPrUrls(runs, [])).toEqual([pr(11)]);
  });

  it('re-offers the PRs of a pass that failed before reaching a conclusion', () => {
    const runs = [run(1, pr(11))];
    const failed = pass([], { outcome: 'failed', failureReason: 'run ended with status ERROR' });
    expect(unexaminedPrUrls(runs, [failed])).toEqual([pr(11)]);
  });
});

describe('skipReason', () => {
  it('runs when the phase is enabled, nothing is open, and there is something to read', () => {
    expect(skipReason(true, [], [pr(11)])).toBeNull();
  });

  it('skips when disabled', () => {
    expect(skipReason(false, [], [pr(11)])).toMatch(/disabled/);
  });

  it('skips while an environment PR is still awaiting a human, naming it', () => {
    const reason = skipReason(true, [{ url: pr(20) }], [pr(11)]);
    expect(reason).toMatch(/already awaiting a human/);
    expect(reason).toContain(pr(20));
  });

  it('skips when every factory PR has already been read', () => {
    expect(skipReason(true, [], [])).toMatch(/not already read/);
  });

  it('reports the open PR before the empty backlog when both apply', () => {
    expect(skipReason(true, [{ url: pr(20) }], [])).toMatch(/already awaiting a human/);
  });
});
