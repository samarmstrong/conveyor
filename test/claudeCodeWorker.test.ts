import { describe, expect, it } from 'vitest';
import { branchNameFor, machineNote, modelArgs, parseResultJson, prUrlIn, sumUsage, usageFrom } from '../src/claudeCodeWorker.ts';

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

  it('tells a read-only agent to change nothing', () => {
    const note = machineNote({ repoUrl: 'https://github.com/o/r', ref: null, branch: null });
    expect(note).toContain('pushes nothing');
    expect(note).not.toContain('gh pr create');
  });
});
