import { beforeEach, describe, expect, it, vi } from 'vitest';

// `gh` as a script: each call is recorded and answered by the first rule its
// arguments match. promisify() resolves with the callback's second argument.
const calls: string[][] = [];
let answer: (args: string[]) => string | Error = () => '';
vi.mock('node:child_process', () => ({
  spawn: () => { throw new Error('not used here'); },
  execFile: (_cmd: string, args: string[], _opts: unknown, cb: (err: unknown, out?: { stdout: string }) => void) => {
    calls.push(args);
    const out = answer(args);
    if (out instanceof Error) cb(Object.assign(out, { stderr: out.message }));
    else cb(null, { stdout: out });
  },
}));

const { mergePr } = await import('../src/github.ts');

const REFUSED = 'X Pull request o/r#7 is not mergeable: the base branch policy prohibits the merge.';
const verbs = () => calls.map((a) => a.slice(0, 2).join(' '));

describe('merging where the base branch requires an approving review', () => {
  beforeEach(() => { calls.length = 0; });

  it('approves as the runner and merges: the merge verdict is the review', async () => {
    let merges = 0;
    answer = (args) => {
      if (args[1] === 'merge') return ++merges === 1 ? new Error(REFUSED) : '';
      if (args[1] === 'view') return JSON.stringify({ reviewDecision: 'REVIEW_REQUIRED' });
      return '';
    };
    await mergePr('o/r', 'https://github.com/o/r/pull/7', 'abcdef1234567890');
    expect(verbs()).toEqual(['pr merge', 'pr view', 'pr review', 'pr merge']);
    expect(calls[2]).toContain('--approve');
    expect(calls[3]).toEqual(expect.arrayContaining(['--match-head-commit', 'abcdef1234567890']));
  });

  it('a PR the runner opened itself cannot be approved by it, and the refusal stands', async () => {
    answer = (args) => {
      if (args[1] === 'merge') return new Error(REFUSED);
      if (args[1] === 'view') return JSON.stringify({ reviewDecision: 'REVIEW_REQUIRED' });
      return new Error('Can not approve your own pull request');
    };
    await expect(mergePr('o/r', 'https://github.com/o/r/pull/7', 'abc')).rejects.toThrow(/base branch policy prohibits/);
    expect(verbs()).toEqual(['pr merge', 'pr view', 'pr review']);
  });

  it('a refusal that is not about a review approves nothing', async () => {
    answer = (args) => {
      if (args[1] === 'merge') return new Error(REFUSED);
      return JSON.stringify({ reviewDecision: 'APPROVED' });
    };
    await expect(mergePr('o/r', 'https://github.com/o/r/pull/7', 'abc')).rejects.toThrow(/base branch policy prohibits/);
    expect(verbs()).toEqual(['pr merge', 'pr view']);
  });

  it('approves at most once, however often GitHub refuses', async () => {
    answer = (args) => {
      if (args[1] === 'merge') return new Error(REFUSED);
      if (args[1] === 'view') return JSON.stringify({ reviewDecision: 'REVIEW_REQUIRED' });
      return '';
    };
    await expect(mergePr('o/r', 'https://github.com/o/r/pull/7', 'abc')).rejects.toThrow(/base branch policy prohibits/);
    expect(verbs().filter((v) => v === 'pr review')).toHaveLength(1);
  });
});

// `--admin` passes anything, so the factory checks for itself that an approval
// is the only thing missing before it uses it.
describe('merge.bypassApproval', () => {
  beforeEach(() => { calls.length = 0; });
  const OWN = new Error('Can not approve your own pull request');
  const world = (over: { view?: object; checks?: object[]; required?: string[] } = {}) => (args: string[]): string | Error => {
    if (args[1] === 'merge') return args.includes('--admin') ? '' : new Error(REFUSED);
    if (args[1] === 'review') return OWN;
    if (args[1] === 'checks') return JSON.stringify(over.checks ?? [{ name: 'ci', bucket: 'pass', link: '' }]);
    if (args[0] === 'api') return JSON.stringify(over.required ?? []);
    return JSON.stringify({ reviewDecision: 'REVIEW_REQUIRED', mergeable: 'MERGEABLE', baseRefName: 'main', ...over.view });
  };
  const url = 'https://github.com/o/r/pull/7';
  const usedAdmin = () => calls.some((a) => a[1] === 'merge' && a.includes('--admin'));

  it('is off unless a deployment asks for it', async () => {
    answer = world();
    await expect(mergePr('o/r', url, 'abc')).rejects.toThrow(/base branch policy prohibits/);
    expect(usedAdmin()).toBe(false);
  });

  it('merges the runner\'s own PR with --admin when an approval is all that is missing', async () => {
    answer = world({ required: ['ci'] });
    await mergePr('o/r', url, 'abc123', undefined, { bypassApproval: true });
    const merge = calls.filter((a) => a[1] === 'merge').at(-1)!;
    expect(merge).toEqual(expect.arrayContaining(['--admin', '--squash', '--match-head-commit', 'abc123']));
  });

  it('approves instead, with no bypass, when the PR is someone else\'s', async () => {
    let merges = 0;
    answer = (args) => {
      if (args[1] === 'merge') return ++merges === 1 ? new Error(REFUSED) : '';
      if (args[1] === 'view') return JSON.stringify({ reviewDecision: 'REVIEW_REQUIRED' });
      return '';
    };
    await mergePr('o/r', url, 'abc', undefined, { bypassApproval: true });
    expect(usedAdmin()).toBe(false);
  });

  it.each([
    ['a red check', { checks: [{ name: 'ci', bucket: 'pass', link: '' }, { name: 'lint', bucket: 'fail', link: '' }] }],
    ['a check still running', { checks: [{ name: 'ci', bucket: 'pending', link: '' }] }],
    ['a required check that never reported', { required: ['ci', 'build'] }],
    ['a conflict', { view: { mergeable: 'CONFLICTING' } }],
    ['changes requested', { view: { reviewDecision: 'CHANGES_REQUESTED' } }],
  ])('never passes %s', async (_what, over) => {
    answer = world(over);
    await expect(mergePr('o/r', url, 'abc', undefined, { bypassApproval: true })).rejects.toThrow(/base branch policy prohibits/);
    expect(usedAdmin()).toBe(false);
  });
});

