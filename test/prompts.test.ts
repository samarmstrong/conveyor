import { describe, expect, it } from 'vitest';
import { groomPrompt, implementPrompt, selectPrompt, simplifyPrompt } from '../src/prompts.ts';
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
    expect(p).toMatch(/every check you did not run/);
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
