import { describe, expect, it } from 'vitest';
import { bumpOf, carried, concluded, depsQueue, depsStamp, droppedReasons, skipReason, upgradeIssue, upgradeKey, upgradeKeyOf, type DepsPr } from '../src/deps.ts';
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

describe('a dropped bump becomes an issue the pipeline owns', () => {
  const sqlalchemy = { number: 1220, url: 'https://github.com/o/r/pull/1220', title: 'chore(deps): update sqlalchemy requirement from >=2.0.54 to >=2.1.0' };

  it('reads each Dropped line, only for offered PRs, first reason wins', () => {
    const body = 'Supersedes #1218\n\nDropped #1220: SQLAlchemy 2.1 makes bare postgresql:// URLs import psycopg.\n- Dropped #1221 — conflicts with #1218\nDropped #9: not offered\nDropped #1220: again';
    expect([...droppedReasons(body, [1218, 1220, 1221])]).toEqual([
      [1220, 'SQLAlchemy 2.1 makes bare postgresql:// URLs import psycopg.'],
      [1221, 'conflicts with #1218'],
    ]);
  });

  it('knows a package by Dependabot\'s title, with its directory when it names one', () => {
    expect(bumpOf(sqlalchemy.title)).toEqual({ pkg: 'sqlalchemy', to: '>=2.1.0', dir: null });
    expect(upgradeKey({ number: 3, title: 'chore(deps): bump axios from 1.6.7 to 1.20.0 in /clients/web' })).toBe('axios@/clients/web');
    expect(upgradeKey({ number: 3, title: 'Bump vitest from 1.0.0 to 2.0.0 in /' })).toBe('vitest');
    expect(upgradeKey({ number: 3, title: 'chore(deps): something odd' })).toBe('pr-3');
  });

  it('files the reason, the done, and a stamp the next bump of the package finds', () => {
    const issue = upgradeIssue(sqlalchemy, 'needs psycopg, or\nURLs moved to psycopg2', 'https://github.com/o/r/pull/1235');
    expect(issue.title).toBe('Upgrade sqlalchemy to >=2.1.0');
    expect(upgradeKeyOf(issue.body)).toBe('sqlalchemy');
    expect(issue.body).toContain('> needs psycopg, or\n> URLs moved to psycopg2');
    expect(issue.body).toContain('https://github.com/o/r/pull/1235');
    expect(issue.body).toContain('**Done**');
    expect(upgradeIssue(sqlalchemy, 'why', null).body).not.toContain('null');
    expect(upgradeKeyOf('an ordinary issue')).toBeNull();
  });
});
