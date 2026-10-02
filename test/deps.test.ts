import { describe, expect, it } from 'vitest';
import { carried, concluded, depsQueue, depsStamp, skipReason, type DepsPr } from '../src/deps.ts';
import { factoryComment } from '../src/groom.ts';
import { depsPrompt } from '../src/prompts.ts';

function pr(number: number, over: Partial<DepsPr> = {}): DepsPr {
  return {
    number,
    url: `https://github.com/o/r/pull/${number}`,
    title: `chore(deps): bump thing ${number}`,
    isDraft: false,
    headRefName: `dependabot/pip/thing-${number}`,
    headRefOid: 'a'.repeat(40),
    files: [{ path: 'requirements.txt' }],
    comments: [],
    ...over,
  };
}

const stamped = (p: DepsPr): DepsPr => ({ ...p, comments: [...p.comments, { body: factoryComment(`${depsStamp(p)}\n🏭 carried`) }] });

describe('which Dependabot PRs a batch is offered', () => {
  it('every open one, oldest first', () => {
    expect(depsQueue([pr(3), pr(1), pr(2)]).map((p) => p.number)).toEqual([1, 2, 3]);
  });

  it('not drafts, and not an Actions bump: the factory does not merge changes under .github/', () => {
    const actions = pr(2, { files: [{ path: '.github/workflows/ci.yml' }] });
    expect(depsQueue([pr(1, { isDraft: true }), actions, pr(3)]).map((p) => p.number)).toEqual([3]);
  });

  it('not one a batch concluded on, until its head moves', () => {
    const done = stamped(pr(1));
    expect(concluded(done)).toBe(true);
    expect(depsQueue([done])).toEqual([]);
    expect(depsQueue([{ ...done, headRefOid: 'b'.repeat(40) }]).map((p) => p.number)).toEqual([1]);
  });
});

describe('what the batch carried', () => {
  it('the offered PRs its description names on a Supersedes line', () => {
    const body = 'Batch.\n\nSupersedes #1218\n- Supersedes #1219\nSupersedes #1220, #1221\n\nDropped #1222: sqlalchemy 2.1 breaks the session API.';
    expect(carried(body, [1218, 1219, 1220, 1221, 1222])).toEqual([1218, 1219, 1220, 1221]);
  });

  it('never a PR it was not offered, whatever the description names', () => {
    expect(carried('Supersedes #7\nSupersedes #1218', [1218])).toEqual([1218]);
  });

  it('nothing when the description names nothing', () => {
    expect(carried('Bumps things. Closes #9.', [9])).toEqual([]);
  });
});

describe('skipReason', () => {
  it('runs when enabled on the cursor worker with no batch open', () => {
    expect(skipReason(true, 'cursor', [])).toBeNull();
  });

  it('off unless asked for, cursor only, and one batch at a time', () => {
    expect(skipReason(false, 'cursor')).toMatch(/disabled/);
    expect(skipReason(true, 'claude-code')).toMatch(/cursor worker/);
    expect(skipReason(true, 'cursor', [{ url: 'https://github.com/o/r/pull/5' }])).toContain('/pull/5');
  });
});

describe('the batch prompt', () => {
  it('hands over links and states the Supersedes rule the controller reads', () => {
    const prompt = depsPrompt(['https://github.com/o/r/pull/1', 'https://github.com/o/r/pull/2']);
    expect(prompt).toContain('https://github.com/o/r/pull/2');
    expect(prompt).toContain('Supersedes #<number>');
  });
});
