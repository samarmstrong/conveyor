import { describe, expect, it } from 'vitest';
import { handbacksSent, redChecks } from '../src/controller.ts';
import { resolveConflictsPrompt } from '../src/prompts.ts';
import { factoryComment } from '../src/groom.ts';
import type { PrCheck } from '../src/github.ts';

const check = (name: string, bucket: PrCheck['bucket']): PrCheck => ({ name, bucket, link: `https://ci/${name}` });

describe('handing red PRs back', () => {
  it('hands back only settled red: a failure with nothing still running', () => {
    expect(redChecks([check('lint', 'pass'), check('tests', 'fail')])?.map((c) => c.name)).toEqual(['tests']);
    expect(redChecks([check('tests', 'fail'), check('build', 'pending')])).toBeNull();
    expect(redChecks([check('tests', 'pass'), check('e2e', 'skipping')])).toBeNull();
  });

  it('counts the ticks that already handed a PR back, from its own comments', () => {
    const comments = [
      { body: factoryComment('🏭 Handed the failing checks back to the agent that opened this (1 of 3): tests.') },
      { body: 'Handed the failing checks back to the agent that opened this — a human quoting it' },
      { body: factoryComment('🏭 The factory opened this.') },
    ];
    expect(handbacksSent(comments)).toBe(1);
  });

  it('counts conflict handbacks apart from check handbacks', () => {
    const comments = [
      { body: factoryComment('🏭 Handed the failing checks back to the agent that opened this (1 of 3): tests.') },
      { body: factoryComment('🏭 Handed the merge conflicts back to the agent that opened this (1 of 3): merge conflicts with main.') },
      { body: factoryComment('🏭 Handed the merge conflicts back to the agent that opened this (2 of 3): merge conflicts with main.') },
    ];
    expect(handbacksSent(comments, 'Handed the merge conflicts back to the agent that opened this')).toBe(2);
    expect(handbacksSent(comments)).toBe(1);
  });

  it('asks only that the conflicts be resolved', () => {
    expect(resolveConflictsPrompt('https://github.com/o/r/pull/9', 'main'))
      .toBe('https://github.com/o/r/pull/9 has merge conflicts with main. Resolve them and push.');
  });
});
