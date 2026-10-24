import { describe, expect, it } from 'vitest';
import { environmentPrompt, fixChecksPrompt, groomEpicPrompt, groomPrompt, implementPrompt, selectPrompt, simplifyPrompt, trackEpicPrompt } from '../src/prompts.ts';
import type { Task } from '../src/types.ts';

const task: Task = {
  id: 'o/r#699',
  issueNumber: 699,
  title: 'Generate API types',
  body: 'A long description that should never be excerpted into a prompt. '.repeat(50),
  comments: [{ body: '<!-- factory-groom sha=abc --> 🏭 groomed\n\n## Factory grooming notes\n\nOnly cases.py.' }],
  labels: ['factory:groomed'],
  assignees: [],
  url: 'https://github.com/o/r/issues/699',
};

// Agents read issues at their links. A prompt that pastes issue text is a
// second, staler, cut-off copy of the issue, so none of them do.
describe('prompts hand over links, not text', () => {
  it('selector gets number, title, and link only', () => {
    const p = selectPrompt([task]);
    expect(p).toContain('#699: Generate API types');
    expect(p).toContain(task.url);
    expect(p).not.toContain('A long description');
  });

  it('implementer gets the link and is pointed at the groom notes, not handed them', () => {
    const p = implementPrompt(task);
    expect(p).toContain(task.url);
    expect(p).toContain('Factory grooming notes');
    expect(p).not.toContain('Only cases.py.');
  });
});

describe('size is judged once', () => {
  it('selector has no veto', () => {
    const p = selectPrompt([task]);
    expect(p).toContain('always pick one');
    expect(p).not.toMatch(/SELECTED:\s*none/);
  });

  it('groomer is told the real run budget', () => {
    expect(groomPrompt(task, 'principles', { maxRunMinutes: 90 })).toContain('about 90 minutes');
  });

  // Reading and verifying dominate a run, so a slice that shares that ground
  // with the rest is a second agent re-learning it.
  it('groomer sizes by what the agent reads and runs, and keeps shared ground in one PR', () => {
    const p = groomPrompt(task, 'principles', { maxRunMinutes: 90 });
    expect(p).toContain('room to use, not only a limit');
    expect(p).toContain('not by the lines it will write');
  });
});

// Whether a change needs a live test is the implementer's call, but it has the
// tools for one, reports every check, and no groomer may scope one away.
describe('verification is the agent\'s call and always reported', () => {
  it('implementer may live-test with agent-browser and reports every check in the PR', () => {
    const p = implementPrompt(task);
    expect(p).toContain('Test the change live when it has behavior worth seeing work');
    expect(p).toContain('agent-browser');
    expect(p).toContain('**Verification** section');
    expect(p).toContain('**Did not run**');
    // Kept apart from "not applicable" so the environment agent gets a clean signal.
    expect(p).toContain('**Blocked by the machine**');
    expect(p).toMatch(/even if you then worked around it/);
  });

  it('implementer triages review findings, when it asks for a review: fix or dismiss with a reason, never a follow-up', () => {
    const p = implementPrompt(task);
    expect(p).toContain('When a change is large or subtle enough');
    expect(p).toContain('gets fixed now');
    expect(p).toContain('dismissed with a sentence saying why');
    expect(p).not.toMatch(/react to what it finds/);
  });

  it('groomer budgets for the live test and may not scope it out', () => {
    const p = groomPrompt(task, 'principles', { maxRunMinutes: 90 });
    expect(p).toContain('live test');
    expect(p).toContain('never tell the implementer to skip one');
  });

  // Unit tests never lay a page out: a screen change is the one case where the
  // live look is not the agent's call.
  it('a change to what a screen renders is always looked at, at two widths', () => {
    const p = implementPrompt(task);
    expect(p).toContain('A change to what a screen renders');
    expect(p).toContain('narrowest width the app supports and at 1920 pixels');
    expect(p).toContain('scrollWidth exceeds its clientWidth');
    expect(p).toContain('Name each screen and width you checked under **Ran**');
  });

  it('an image in the issue is spec for the groomer and the implementer, fetched even on a private repo', () => {
    for (const p of [implementPrompt(task), groomPrompt(task, 'principles', { maxRunMinutes: 90 }), groomEpicPrompt(task, 'principles', { maxRunMinutes: 90 })]) {
      expect(p).toContain('as binding as its text');
      expect(p).toContain('application/vnd.github.full+json');
    }
  });

  // The implementer compares its screen with the design itself: one sentence,
  // no independent judge, no region-by-region procedure.
  it('implementer compares its screen with the design it was pointed at and lists what differs', () => {
    const p = implementPrompt(task);
    expect(p).toContain('same width and state as your screen');
    expect(p).toContain('"it lines up" is not a finding');
    expect(p).not.toMatch(/subagent that has not seen/);
    expect(p).not.toMatch(/region by region/);
  });
});

// An epic is groomed as direction: the agent settles the open decisions itself,
// asks a human only for the irreversible ones, and writes the children.
describe('epics', () => {
  const epic = { ...task, labels: ['type:epic'] };
  const p = groomEpicPrompt(epic, 'principles', { maxRunMinutes: 90 });

  it('gets the link, never the body', () => {
    expect(p).toContain(epic.url);
    expect(p).not.toContain('A long description');
  });

  it('settles decisions with defaults and reversal costs, and reserves needs-work for human-only decisions', () => {
    expect(p).toContain('reverse');
    expect(p).toContain('irreversible');
    expect(p).toMatch(/do not send back a list of questions/);
  });

  it('writes children in fenced child blocks, sized to the implementer budget', () => {
    expect(p).toContain('```child');
    expect(p).toContain('Make each child as large as that standard allows');
    expect(p).toContain('however many children that is');
    expect(p).toContain('WAITING: #<issue or PR number>');
    expect(p).toContain('Do not join unrelated work');
    expect(p).toContain('about 90 minutes');
    expect(p).toContain('Write no children for a needs-work or done epic');
    expect(p).toContain('VERDICT: done');
    expect(p).toContain('a child groomed needs-work');
    expect(p).toContain('CLOSE: #<issue number>');
    expect(p).toContain('yours to answer');
    expect(p).not.toContain('may do on its own');
  });

  it('ratchets on a re-review: settled decisions stand unless the reply names them', () => {
    expect(p).toContain('re-review');
    expect(p).toContain('ratchets');
    expect(p).toMatch(/which decisions changed and which stand/);
  });

  // Drift from the design accumulates between children, not inside one, so the
  // epic's re-review is where the design is compared with the running app.
  it('compares the design with the running app on a re-review before the next slice or done', () => {
    expect(p).toContain('When the epic changes what a screen renders');
    expect(p).toContain('before you write the next slice or call the epic done');
    expect(p).toContain('open the design and the running app at the same state and width');
    expect(p).toMatch(/Done means the screens match the design as far as the record meant them to/);
  });

  // The factory's own bookkeeping brings a settled epic back once a slice
  // lands; that review tracks the record instead of settling it again.
  it('a tracking re-review starts from the record, compares the touched screens, and writes the next slice', () => {
    const t = trackEpicPrompt(epic, 'principles', { maxRunMinutes: 90 });
    expect(t).toContain(epic.url);
    expect(t).toContain('it does not settle the direction again');
    expect(t).toContain('read their pull requests rather than the whole codebase again');
    expect(t).toContain('for the screens the children since the record touched');
    expect(t).toContain('Before you call the epic done, compare every screen it covers');
    expect(t).toContain('CLOSE: #<issue number>');
    expect(t).toContain('ratchets');
    expect(t).toContain('```child');
    expect(t).toContain('WAITING: #<issue or PR number>');
    expect(t).toContain('VERDICT: done');
    expect(t).toContain('principles');
  });

  it('the ordinary groom prompt knows about epics and blockers', () => {
    const g = groomPrompt(task, 'principles', { maxRunMinutes: 90 });
    expect(g).toContain('part of an epic');
    expect(g).toContain('BLOCKED: #<issue number>');
    expect(g).toContain('the record this issue was judged against has changed');
  });

  it('the ordinary groom may answer "epic" only when the repo has an epic label', () => {
    const with_ = groomPrompt(task, 'principles', { maxRunMinutes: 90 }, 'type:epic');
    expect(with_).toContain('Four verdicts');
    expect(with_).toContain('VERDICT: close');
    expect(with_).toContain('VERDICT: epic');
    expect(with_).toContain('`type:epic`');
    expect(with_).toContain('Size alone does not make an epic');
    const without = groomPrompt(task, 'principles', { maxRunMinutes: 90 });
    expect(without).toContain('Three verdicts');
    expect(without).toContain('yours to answer');
    expect(without).not.toContain('VERDICT: epic');
  });
});

// The simplifier is held to the implementer's standard, and told the one rule
// the controller will enforce on its PR.
describe('simplification', () => {
  const merged = 'https://github.com/o/r/pull/810';
  const declined = 'https://github.com/o/r/pull/811';
  const p = simplifyPrompt({ recentPrs: [merged], declinedPrs: [], budget: { maxRunMinutes: 90 } });

  it('shares the working rules with the implementer', () => {
    for (const rule of ['agent-browser', '**Verification** section', 'gets fixed now']) {
      expect(p).toContain(rule);
      expect(implementPrompt(task)).toContain(rule);
    }
  });

  it('states the line-count rule and names the ways agents cheat it', () => {
    expect(p).toContain('remove more lines than it adds');
    expect(p).toContain('no test asserting a deleted thing is gone');
    expect(p).toContain('about 90 minutes');
  });

  it('gets links to merged factory PRs, and to declined ones only when there are any', () => {
    expect(p).toContain(merged);
    expect(p).not.toContain('already declined');
    expect(simplifyPrompt({ recentPrs: [], declinedPrs: [declined], budget: { maxRunMinutes: 90 } })).toContain(declined);
  });
});

// The environment agent once called "installed the deps myself" an inconvenience
// and declined, PR after PR, to add the project's toolchain. CI is now its
// reference, and it is shown its own past verdicts so the pattern is visible.
describe('environment agent judges against CI and sees its own history', () => {
  const prs = ['https://github.com/o/r/pull/850'];

  it('names CI as the reference machine and counts self-setup as a gap', () => {
    const p = environmentPrompt(prs);
    expect(p).toContain('.github/workflows');
    expect(p).toMatch(/ran only after setting the machine up themselves/);
    expect(p).toMatch(/services:/);
    expect(p).toContain(prs[0]);
  });

  it('links its recent verdicts when there are any, and says nothing about them otherwise', () => {
    const verdicts = ['https://github.com/o/r/pull/840#issuecomment-1'];
    expect(environmentPrompt(prs, verdicts)).toContain('## Your recent verdicts');
    expect(environmentPrompt(prs, verdicts)).toContain(verdicts[0]);
    expect(environmentPrompt(prs)).not.toContain('recent verdicts');
  });

  it('a defect in the repo is filed as an issue block, not fixed in the image or left as prose', () => {
    const p = environmentPrompt(prs);
    expect(p).toContain('Some gaps are the repo\'s, and those you file.');
    expect(p).toContain('```issue');
    expect(p).toMatch(/check the repo's open issues for the same defect/);
    expect(p).toMatch(/do not put it in the environment file/);
  });

  it('is told the factory boots an agent on its branch before a human sees the PR', () => {
    expect(environmentPrompt(prs)).toContain('an environment that builds is not one that boots');
  });

  it('the implementer files a shipped config that would not start under the same heading', () => {
    expect(implementPrompt(task)).toMatch(/a shipped config or script of this repo that would not start until you changed it/);
  });
});

// CI is the repo's own verdict. The factory relays a red check to the agent
// that wrote the code rather than to a human, and the agent judges whose it is.
describe('red checks go back to the implementer', () => {
  it('working rules leave the full suites to CI, which hands a red check back', () => {
    const p = implementPrompt(task);
    expect(p).toContain('the tests that cover what you changed');
    expect(p).toContain('hands a red check back to you');
  });

  it('fix prompt says only to fix the failing checks, with links to their jobs', () => {
    const p = fixChecksPrompt('https://github.com/o/r/pull/959', [
      { name: 'Unit Tests - Backend', link: 'https://github.com/o/r/actions/runs/1/job/2' },
    ]);
    expect(p).toBe('Fix the failing CI checks on https://github.com/o/r/pull/959:\n\n- Unit Tests - Backend: https://github.com/o/r/actions/runs/1/job/2');
  });
});

// A credential is handed over by name and purpose only. The value is in the
// agent's shell; the prompt says what it is for, so the live test that needs
// the real service gets run instead of reported as blocked.
describe('credentials reach agents as names, never values', () => {
  const creds = [{ name: 'MODEL_API_KEY', description: 'API key for the model provider the app calls.' }];

  it('implementer is told what is in its environment and what it is for', () => {
    const p = implementPrompt(task, creds);
    expect(p).toContain('## Credentials in your environment');
    expect(p).toContain('`MODEL_API_KEY`: API key for the model provider the app calls.');
    expect(p).toContain('Never print, commit, or paste a value');
  });

  it('no section when the factory holds nothing', () => {
    expect(implementPrompt(task)).not.toContain('Credentials in your environment');
  });

  it('environment agent knows which credentials the factory holds', () => {
    const prs = ['https://github.com/o/r/pull/1'];
    expect(environmentPrompt(prs, [], creds)).toContain('`MODEL_API_KEY`');
    expect(environmentPrompt(prs, [], creds)).toContain('skipped by the implementer, not the machine');
    expect(environmentPrompt(prs)).not.toContain('The factory does hold');
  });
});
