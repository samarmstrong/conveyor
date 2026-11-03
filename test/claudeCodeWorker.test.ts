import { afterEach, describe, expect, it, vi } from 'vitest';
import { branchNameFor, Gate, headroomWait, hitUsageLimit, lostLogin, machineNote, modelArgs, parseResultJson, parseUsage, prUrlIn, retrying, sumUsage, usageFrom } from '../src/claudeCodeWorker.ts';

describe('modelArgs', () => {
  it('passes nothing when the config leaves the model to the runtime', () => {
    expect(modelArgs(null)).toEqual([]);
  });

  it("translates Cursor's params: context 1m → [1m] suffix, effort → --effort, thinking dropped", () => {
    expect(modelArgs({ id: 'claude-fable-5-1', params: { thinking: 'true', context: '1m', effort: 'low' } }))
      .toEqual(['--model', 'claude-fable-5-1[1m]', '--effort', 'low']);
  });

  it('does not double the suffix', () => {
    expect(modelArgs({ id: 'opus[1m]', params: { context: '1m' } })).toEqual(['--model', 'opus[1m]']);
  });
});

describe('modelArgs effort', () => {
  it("takes Cursor's reasoning_effort as --effort too", () => {
    expect(modelArgs({ id: 'claude-sonnet-5-5', params: { context: '300k', reasoning_effort: 'high' } }))
      .toEqual(['--model', 'claude-sonnet-5-5', '--effort', 'high']);
  });
});

describe('hitUsageLimit', () => {
  it('recognises the session-limit report a cut-off run ends with', () => {
    expect(hitUsageLimit("You've hit your session limit · resets 2:30pm (America/New_York)")).toBe(true);
    expect(hitUsageLimit('Claude AI usage limit reached|1760000000')).toBe(true);
    expect(hitUsageLimit('tests failed: rate limit on the GitHub API')).toBe(false);
  });
});

describe('lostLogin', () => {
  it('recognises a run that found no login', () => {
    expect(lostLogin('Not logged in · Please run /login')).toBe(true);
    expect(lostLogin('OAuth token has expired. Please obtain a new token or refresh your existing token.')).toBe(true);
    expect(lostLogin('the login form test failed')).toBe(false);
  });
});

describe('parseUsage', () => {
  it('reads the five-hour and weekly windows and skips the rest', () => {
    expect(parseUsage({
      five_hour: { utilization: 55, resets_at: '2026-10-07T22:39:59.617090+00:00' },
      seven_day: { utilization: 16, resets_at: null },
      seven_day_opus: null,
    })).toEqual([
      { name: 'five-hour', utilization: 55, resetsAt: Date.parse('2026-10-07T22:39:59.617Z') },
      { name: 'weekly', utilization: 16, resetsAt: null },
    ]);
  });
});

describe('headroomWait', () => {
  const now = Date.parse('2026-10-07T20:00:00Z');
  const reset = Date.parse('2026-10-07T22:40:00Z');

  it('lets a run start below the threshold', () => {
    expect(headroomWait([{ name: 'five-hour', utilization: 89, resetsAt: reset }], 90, now)).toBeNull();
  });

  it('waits for the reset of every window at or past it', () => {
    const later = Date.parse('2026-10-10T00:00:00Z');
    const wait = headroomWait([
      { name: 'five-hour', utilization: 90, resetsAt: reset },
      { name: 'weekly', utilization: 95, resetsAt: later },
    ], 90, now);
    expect(wait?.untilMs).toBe(later);
    expect(wait?.full.map((w) => w.name)).toEqual(['five-hour', 'weekly']);
  });

  it('looks again in a while when the reset time is unknown or past', () => {
    expect(headroomWait([{ name: 'five-hour', utilization: 100, resetsAt: null }], 90, now)?.untilMs).toBe(now + 15 * 60_000);
    expect(headroomWait([{ name: 'five-hour', utilization: 100, resetsAt: now - 1 }], 90, now)?.untilMs).toBe(now + 15 * 60_000);
  });
});

describe('parseResultJson', () => {
  it('reads the single object claude prints', () => {
    expect(parseResultJson('{"type":"result","result":"done"}\n')?.result).toBe('done');
  });

  it('skips noise a hook printed before it', () => {
    expect(parseResultJson('hook says hi\n{"type":"result","result":"done"}')?.result).toBe('done');
  });

  it('is null for no output', () => {
    expect(parseResultJson('')).toBeNull();
    expect(parseResultJson('not json')).toBeNull();
  });
});

describe('usageFrom', () => {
  it('sums modelUsage across models and carries cost in cents', () => {
    const usage = usageFrom({
      total_cost_usd: 0.0177738,
      modelUsage: {
        'claude-haiku-4-5-20251001': { inputTokens: 913, outputTokens: 61, cacheReadInputTokens: 14138, cacheCreationInputTokens: 7571 },
        'claude-sonnet-5': { inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      },
    });
    expect(usage).toEqual({
      inputTokens: 1013, outputTokens: 71, cacheWriteTokens: 7571, cacheReadTokens: 14138,
      totalTokens: 1013 + 71 + 7571 + 14138, costCents: 1.78,
    });
  });

  it('falls back to the top-level usage block', () => {
    expect(usageFrom({ usage: { input_tokens: 9, output_tokens: 49, cache_creation_input_tokens: 7571, cache_read_input_tokens: 14138 } }))
      .toMatchObject({ inputTokens: 9, outputTokens: 49, cacheWriteTokens: 7571, cacheReadTokens: 14138 });
  });

  it('is null when the result carries no usage at all', () => {
    expect(usageFrom({ result: 'x' })).toBeNull();
  });
});

describe('sumUsage', () => {
  it('adds the runs of one session', () => {
    const a = { inputTokens: 1, outputTokens: 2, cacheWriteTokens: 3, cacheReadTokens: 4, totalTokens: 10, costCents: 1.5 };
    const b = { inputTokens: 10, outputTokens: 20, cacheWriteTokens: 30, cacheReadTokens: 40, totalTokens: 100 };
    expect(sumUsage([a, b])).toEqual({ inputTokens: 11, outputTokens: 22, cacheWriteTokens: 33, cacheReadTokens: 44, totalTokens: 110, costCents: 1.5 });
    expect(sumUsage([])).toBeUndefined();
  });
});

describe('prUrlIn', () => {
  it('finds the last PR link on the target repo and ignores other repos', () => {
    const text = 'See https://github.com/other/repo/pull/1. Opened https://github.com/o/r/pull/41 then superseded by https://github.com/o/r/pull/42.';
    expect(prUrlIn(text, 'https://github.com/o/r')).toBe('https://github.com/o/r/pull/42');
    expect(prUrlIn(text, 'https://github.com/o/r.git')).toBe('https://github.com/o/r/pull/42');
    expect(prUrlIn('no pr here', 'https://github.com/o/r')).toBeUndefined();
  });
});

describe('branchNameFor', () => {
  it('slugs the run name under factory/ and pins the session', () => {
    expect(branchNameFor('factory: #123 Fix the Thing!', '0123456789abcdef')).toBe('factory/123-fix-the-thing-01234567');
    expect(branchNameFor('factory-simplify', 'abcdefabcdef')).toBe('factory/simplify-abcdefab');
    expect(branchNameFor(undefined, 'abcdefabcdef')).toBe('factory/agent-abcdefab');
  });

  it('keeps long titles to a branch-sized slug', () => {
    const name = branchNameFor(`factory: #9 ${'word '.repeat(30)}`, 'ffffffffffff');
    expect(name.length).toBeLessThan(60);
    expect(name).toMatch(/^factory\/9-word(-word)*-ffffffff$/);
  });
});

describe('machineNote', () => {
  it('tells a PR-opening agent its branch and how to publish', () => {
    const note = machineNote({ repoUrl: 'https://github.com/o/r', ref: 'abc123', branch: 'factory/1-x-deadbeef' });
    expect(note).toContain('factory/1-x-deadbeef');
    expect(note).toContain('gh pr create');
    expect(note).toContain('abc123');
  });

  it('puts a handback on the PR it fixes: push to its branch, open no other', () => {
    const note = machineNote({ repoUrl: 'https://github.com/o/r', ref: 'abc123', branch: 'factory/1-x-deadbeef', prUrl: 'https://github.com/o/r/pull/9' });
    expect(note).toContain('https://github.com/o/r/pull/9');
    expect(note).toContain('git push origin factory/1-x-deadbeef');
    expect(note).toContain('Do not open another PR');
    expect(note).not.toContain('gh pr create');
  });

  it('tells every agent that changes code to run its checks in the foreground', () => {
    expect(machineNote({ repoUrl: 'https://github.com/o/r', ref: null, branch: 'b' })).toContain('in the foreground');
    expect(machineNote({ repoUrl: 'https://github.com/o/r', ref: null, branch: 'b', prUrl: 'https://github.com/o/r/pull/9' })).toContain('in the foreground');
  });

  it('tells every agent the machine is shared, and how to take the live stack', () => {
    for (const branch of ['factory/1-x-abcdef12', null]) {
      const note = machineNote({ repoUrl: 'https://github.com/o/r', ref: 'abc', branch });
      expect(note).toContain('factory-slot take');
      expect(note).toContain('factory-slot release');
    }
  });

  it('tells a fork review its branch is pushed only as the task says, and the factory opens the PR', () => {
    const note = machineNote({ repoUrl: 'https://github.com/o/r', ref: 'abc', branch: 'factory/review-1-abcdef12', pushOnly: true });
    expect(note).toContain('factory/review-1-abcdef12');
    expect(note).toContain('do not run `gh pr create`');
    expect(note).not.toContain('The PR must exist');
  });

  it('tells an agent in a container the machine and its stack are its own, and what of the boot failed', () => {
    const booted = machineNote({ repoUrl: 'https://github.com/o/r', ref: 'abc', branch: null, container: { boot: [] } });
    expect(booted).toContain('container of your own');
    expect(booted).toContain('already run its install and start');
    expect(booted).not.toContain('factory-slot');
    const failed = machineNote({ repoUrl: 'https://github.com/o/r', ref: 'abc', branch: null, container: { boot: ["the environment's `start` exited 1; its output is in ~/factory-start.log"] } });
    expect(failed).toContain('~/factory-start.log');
  });

  it('tells a read-only agent to change nothing', () => {
    const note = machineNote({ repoUrl: 'https://github.com/o/r', ref: null, branch: null });
    expect(note).toContain('pushes nothing');
    expect(note).not.toContain('gh pr create');
  });
});

describe('retrying', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('clones again after a dropped connection, and gives up with the last error', async () => {
    vi.useFakeTimers();
    const flaky = vi.fn()
      .mockRejectedValueOnce(new Error('RPC failed; curl 56'))
      .mockResolvedValueOnce('cloned');
    const waits: number[] = [];
    const ok = retrying(flaky, [5_000, 15_000], (_, ms) => waits.push(ms));
    await vi.runAllTimersAsync();
    await expect(ok).resolves.toBe('cloned');
    expect(waits).toHaveLength(1);
    expect(waits[0]).toBeGreaterThanOrEqual(5_000);
    expect(waits[0]).toBeLessThanOrEqual(7_500);

    const dead = vi.fn().mockRejectedValue(new Error('early EOF'));
    const failed = retrying(dead, [5_000, 15_000]);
    const settled = expect(failed).rejects.toThrow('early EOF');
    await vi.runAllTimersAsync();
    await settled;
    expect(dead).toHaveBeenCalledTimes(3);
  });
});

describe('Gate', () => {
  it('lets size holders in at once and the rest in order, each as a holder leaves', async () => {
    const gate = new Gate(2);
    const order: string[] = [];
    await gate.enter();
    expect(gate.tryEnter()).toBe(true);
    expect(gate.tryEnter()).toBe(false);
    const c = gate.enter().then(() => order.push('c'));
    const d = gate.enter().then(() => order.push('d'));
    expect(gate.waiting).toBe(2);

    gate.leave();
    await c;
    expect(order).toEqual(['c']);
    // The place passed to c: none is free for a newcomer to jump the queue.
    expect(gate.tryEnter()).toBe(false);

    gate.leave();
    await d;
    expect(order).toEqual(['c', 'd']);
    gate.leave();
    gate.leave();
    expect(gate.tryEnter()).toBe(true);
    expect(gate.tryEnter()).toBe(true);
    expect(gate.tryEnter()).toBe(false);
  });
});
