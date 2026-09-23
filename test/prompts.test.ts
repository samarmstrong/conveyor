import { describe, expect, it } from 'vitest';
import { environmentPrompt, fixChecksPrompt, groomEpicPrompt, groomPrompt, implementPrompt, selectPrompt, simplifyPrompt } from '../src/prompts.ts';
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
});

// The live test is the check the factory was built to get, so no prompt may
// leave it optional or let another agent scope it away.
describe('verification is required and reported', () => {
  it('implementer is told to live-test with agent-browser and to report every check in the PR', () => {
    const p = implementPrompt(task);
    expect(p).toContain('agent-browser');
    expect(p).toContain('**Verification** section');
    expect(p).toContain('**Did not run**');
    // Kept apart from "not applicable" so the environment agent gets a clean signal.
    expect(p).toContain('**Blocked by the machine**');
    expect(p).toMatch(/even if you then worked around it/);
  });

  it('implementer triages review findings: fix or dismiss with a reason, never a follow-up', () => {
    const p = implementPrompt(task);
    expect(p).toContain('gets fixed now');
    expect(p).toContain('dismissed with a sentence saying why');
    expect(p).not.toMatch(/react to what it finds/);
  });

  it('groomer budgets for the live test and may not scope it out', () => {
    const p = groomPrompt(task, 'principles', { maxRunMinutes: 90 });
    expect(p).toContain('live test');
    expect(p).toContain('never tell the implementer to skip one');
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
    expect(p).toContain('about 90 minutes');
    expect(p).toContain('Write no children for a needs-work epic');
  });

  it('ratchets on a re-review: settled decisions stand unless the reply names them', () => {
    expect(p).toContain('re-review');
    expect(p).toContain('ratchets');
    expect(p).toMatch(/which decisions changed and which stand/);
  });

  it('the ordinary groom prompt knows about epics and blockers', () => {
    const g = groomPrompt(task, 'principles', { maxRunMinutes: 90 });
    expect(g).toContain('part of an epic');
    expect(g).toContain('BLOCKED: #<issue number>');
    expect(g).toContain('the record this issue was judged against has changed');
  });

  it('the ordinary groom may answer "epic" only when the repo has an epic label', () => {
    const with_ = groomPrompt(task, 'principles', { maxRunMinutes: 90 }, 'type:epic');
    expect(with_).toContain('Three verdicts');
    expect(with_).toContain('VERDICT: epic');
    expect(with_).toContain('`type:epic`');
    expect(with_).toContain('Size alone does not make an epic');
    const without = groomPrompt(task, 'principles', { maxRunMinutes: 90 });
    expect(without).toContain('Two verdicts');
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

  it('the implementer files a shipped config that would not start under the same heading', () => {
    expect(implementPrompt(task)).toMatch(/a shipped config or script of this repo that would not start until you changed it/);
  });
});

// CI is the repo's own verdict. The factory relays a red check to the agent
// that wrote the code rather than to a human, and the agent judges whose it is.
describe('red checks go back to the implementer', () => {
  it('working rules ask for the suites CI runs, not the ones near the change', () => {
    expect(implementPrompt(task)).toContain('the full suites CI runs');
  });

  it('fix prompt hands links to the failing jobs and forbids a new PR or a skipped check', () => {
    const p = fixChecksPrompt('https://github.com/o/r/pull/959', [
      { name: 'Unit Tests - Backend', link: 'https://github.com/o/r/actions/runs/1/job/2' },
    ]);
    expect(p).toContain('https://github.com/o/r/pull/959');
    expect(p).toContain('- Unit Tests - Backend: https://github.com/o/r/actions/runs/1/job/2');
    expect(p).toContain('fails the same way on the default branch');
    expect(p).toContain('Do not open a new PR');
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
