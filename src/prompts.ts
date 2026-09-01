// The factory's prompts. Deliberately short: the models' default coding,
// verification, and review behavior is trusted. Lines here exist only where we
// are specifically opinionated about doing something differently than default.

import type { Task } from './types.ts';
import { groomNotes } from './groom.ts';

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

Read the issue there, comments included, then look at the code it concerns — you are reviewing, not implementing, so change nothing. Judge it against the product-direction principles below: they are the standard this codebase is held to, and they outrank how the issue's author framed it.

Two verdicts:
- groomed — there is a correct change here that one PR can land. It may be narrower than what the issue asks for; if it is, your notes say what to leave out. The implementer decides how to build it — an issue that leaves implementation open is not thereby unready.
- needs-work — there is not. Say why, concretely, pointing at files.

Do not invent a smaller task to rescue a bad issue. If the narrowed change is not worth doing on its own, or the point of the issue was the part you would be cutting, that is needs-work.

If there is something the implementer must know, put it in a fenced \`\`\`notes block: concrete implementation-level direction — the boundary to stay inside, the approach to avoid, the existing code to reuse. Those notes go into the comment the factory posts on the issue and are the only thing you send downstream, so write instructions rather than principles, and leave the block out entirely when the issue is already clear enough. Do not pad it.

Everything else you write becomes that comment's rationale, so say what you concluded and why in the open, addressed to the issue's author.

End your reply with exactly one line:
VERDICT: groomed
or
VERDICT: needs-work

## Principles

${principles}`;
}

export function implementPrompt(task: Task): string {
  const notes = groomNotes(task);
  const notesSection = notes
    ? `\n\n## Grooming notes\nFrom the factory's groom of this issue. Scoping direction, not a suggestion.\n\n${notes}`
    : '';

  return `Implement the GitHub issue below and open a PR that resolves it (reference "Closes #${task.issueNumber}").

How we like to work in this repo:
- Keep code concise, with brief inline comments only where useful.
- Verify with the project's own checks (tests, typecheck, lint; app startup / a browser look with screenshot if the change is user-visible). Add tests only for critical behavior; skip low-value assertions.
- Before opening the PR, have an independent subagent review your full diff with fresh eyes, and react to what it finds.

## Issue #${task.issueNumber}: ${task.title}
${task.url}

Read the issue at that URL, comments included — do not work from the title alone.${notesSection}`;
}

/**
 * The environment agent. It is handed PR *links*, not a report extracted from
 * the implementer's reply: an agent that could not verify its work says so in
 * its PR, and reading that is a judgment call, so it belongs in an agent rather
 * than in a parser. The Docker specifics are here because they are the one
 * thing a model reliably gets wrong — cloud agents can run Docker, but not on
 * the default image and not without the overlay/iptables workarounds.
 */
export function environmentPrompt(prUrls: string[]): string {
  return `You own the environment the factory's coding agents run in. They are Cursor cloud agents working on this repo, and their machine is whatever \`.cursor/environment.json\` at the repo root configures — an install command, a dashboard snapshot, or a Dockerfile build. There may not be one yet, in which case they get Cursor's automatic setup.

Below are pull requests the factory's implementers opened. Read each one — the description, and the diff where you need it. You are looking for one thing: **a check the author would have run and could not, because the machine lacked something.** They say so plainly, usually under a verification heading.

If you find a gap the environment can close, close it. Commit \`.cursor/environment.json\` and any Dockerfile it needs, change nothing else, and open a PR. Two things worth knowing:

- Docker is available to cloud agents but not on the default image. Installing \`docker-ce\` is not enough on its own: the daemon needs the \`fuse-overlayfs\` storage driver and \`iptables-legacy\`, and the \`ubuntu\` user needs to be in the \`docker\` group. Cursor documents the working Dockerfile at https://cursor.com/docs/cloud-agent/setup — follow it rather than improvising.
- Build the smallest environment that unblocks the checks you actually saw blocked. A general-purpose developer image costs every future agent its startup time, and you can add to this file again next week.

**Not every gap is yours to close.** A check that needs an artifact which does not exist yet at review time, or a credential the factory does not hold, is not an environment problem — the implementer verified the wrong thing, and the honest fix is a different check. When that is what you find, say what should have been verified instead and open no PR. Do not install your way around it.

Open no PR when nothing was blocked; that is the expected outcome most of the time, and a needless PR costs a human review. Whatever you write is posted back onto the PRs you read, so write it to the humans reviewing them.

## Pull requests

${prUrls.join('\n')}`;
}
