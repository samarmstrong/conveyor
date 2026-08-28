// The factory's prompts. Deliberately short: the models' default coding,
// verification, and review behavior is trusted. Lines here exist only where we
// are specifically opinionated about doing something differently than default.

import type { Task } from './types.ts';
import { NOTES_HEADING } from './groom.ts';

const BODY_PREVIEW_CHARS = 1500;

export function selectPrompt(tasks: Task[]): string {
  const list = tasks
    .map((t) => {
      const body = t.body.length > BODY_PREVIEW_CHARS
        ? `${t.body.slice(0, BODY_PREVIEW_CHARS)}\n…(truncated — full text at the issue URL)`
        : t.body;
      return `### #${t.issueNumber}: ${t.title}${t.labels.length ? ` [${t.labels.join(', ')}]` : ''}\n${t.url}\n\n${body}`;
    })
    .join('\n\n---\n\n');

  return `Below are the groomed GitHub issues. Pick the ONE that is most well-scoped for an autonomous coding agent to implement end-to-end in a single PR. Look around the codebase if that helps you judge.

Briefly explain your pick, then end your reply with a single line:
SELECTED: #<issue number>
or, if nothing here is a responsible pick:
SELECTED: none

## Groomed issues

${list}`;
}

/**
 * Grooming is upstream of selection: it decides whether an issue is worth
 * building at all, against the product-direction principles. The principles
 * reach only this agent — what the implementer needs is whatever this agent
 * writes into the notes.
 */
export function groomPrompt(task: Task, principles: string): string {
  return `Groom GitHub issue #${task.issueNumber} for an autonomous coding agent.
${task.url}

Read the issue there, then look at the code it concerns — you are reviewing, not implementing, so change nothing. Judge it against the product-direction principles below: they are the standard this codebase is held to, and they outrank how the issue's author framed it.

Two verdicts:
- groomed — there is a correct change here that one PR can land. It may be narrower than what the issue asks for; if it is, your notes say what to leave out. The implementer decides how to build it — an issue that leaves implementation open is not thereby unready.
- needs-work — there is not. Say why, concretely, pointing at files.

Do not invent a smaller task to rescue a bad issue. If the narrowed change is not worth doing on its own, or the point of the issue was the part you would be cutting, that is needs-work.

If there is something the implementer must know, put it in a fenced \`\`\`notes block: concrete implementation-level direction — the boundary to stay inside, the approach to avoid, the existing code to reuse. Those notes get appended to the issue and are the only thing you send downstream, so write instructions rather than principles, and leave the block out entirely when the issue is already clear enough. Do not pad it.

End your reply with exactly one line:
VERDICT: groomed
or
VERDICT: needs-work

## Principles

${principles}`;
}

export function implementPrompt(task: Task): string {
  const notesLine = task.body.includes(NOTES_HEADING)
    ? '\n- The issue carries a "Factory grooming notes" section. That is scoping direction, not a suggestion.'
    : '';

  return `Implement the GitHub issue below and open a PR that resolves it (reference "Closes #${task.issueNumber}").

How we like to work in this repo:
- Verify with the project's own checks (tests, typecheck, lint; app startup / a browser look with screenshot if the change is user-visible). Add a test that would fail without your change.
- Before opening the PR, have an independent subagent review your full diff with fresh eyes, and react to what it finds.${notesLine}

## Issue #${task.issueNumber}: ${task.title}
${task.url}

Read the issue at that URL — do not work from the title alone.`;
}
