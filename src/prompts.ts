// The factory's prompts. Deliberately short: the models' default coding,
// verification, and review behavior is trusted. Lines here exist only where we
// are specifically opinionated about doing something differently than default.
//
// Every prompt hands the agent LINKS, never the text behind them. An agent reads
// an issue better than a prompt can excerpt it — it sees comments, edits, and
// whatever else has accumulated, and nothing is cut off at a character limit.

import type { Task } from './types.ts';

/** What the implementer actually is, so grooming's "one PR" means something. */
export interface RunBudget {
  maxRunMinutes: number;
}

export function selectPrompt(tasks: Task[]): string {
  const list = tasks
    .map((t) => `- #${t.issueNumber}: ${t.title}${t.labels.length ? ` [${t.labels.join(', ')}]` : ''}\n  ${t.url}`)
    .join('\n');

  return `Below are GitHub issues the factory has groomed: each has already been judged to hold a change one autonomous coding agent can land in a single PR, and the factory's groom comment on the issue (🏭 Factory groom) fixes the scope that agent will be handed. Read each issue at its link, comments included, and pick the ONE to implement next — the best-defined, most self-contained scope. Look around the codebase if that helps you compare them.

You are ranking, not re-vetting. Whether an issue is small enough was grooming's call and the implementer's attempt is what tests it, so always pick one. If you believe a groom verdict is wrong, say so in your reasoning and pick anyway.

Briefly explain your pick, then end your reply with a single line:
SELECTED: #<issue number>

## Groomed issues

${list}`;
}

/**
 * Grooming is upstream of selection: it decides whether an issue is worth
 * building at all, against the product-direction principles. The principles
 * reach only this agent — what the implementer needs is whatever this agent
 * writes into the notes.
 */
export function groomPrompt(task: Task, principles: string, budget: RunBudget): string {
  return `Groom GitHub issue #${task.issueNumber} for an autonomous coding agent.
${task.url}

Read the issue there, comments included, then look at the code it concerns — you are reviewing, not implementing, so change nothing. Judge it against the product-direction principles below: they are the standard this codebase is held to, and they outrank how the issue's author framed it.

Two verdicts:
- groomed — there is a correct change here that one PR can land. It may be narrower than what the issue asks for; if it is, your notes say what to leave out. The implementer decides how to build it — an issue that leaves implementation open is not thereby unready.
- needs-work — there is not. Say why, concretely, pointing at files.

"One PR" has a concrete meaning here. The implementer is a single fresh cloud agent with a budget of about ${budget.maxRunMinutes} minutes to read the issue, build the change, verify it — the project's own checks, then a live test of the changed behavior; the machine has a browser for that — and open the PR. It can spawn subagents and it is capable, so do not scope for a timid agent — but a change that cannot plausibly be built and verified in that one run is not one PR, whatever the issue calls it. If you narrow the issue to a slice, the slice is what has to fit.

You are the only judge of size. Nothing downstream re-vets your verdict; the implementer's attempt is what tests it. If a factory comment on the issue reports an earlier attempt that did not land (🏭 Factory attempt), that is evidence about size: weigh it, and a groomed verdict then has to say what is different this time.

Verification is part of the size, not a place to find room. Your notes may say what a live test should exercise; they never tell the implementer to skip one so the work fits. A change that only fits unverified is not one PR.

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

/**
 * How every agent that opens a PR here works: verify live, get a review, report
 * every check. Shared by the implementer and the simplifier so the two cannot
 * drift — a simplification is held to exactly the standard the code it removes
 * was built to.
 */
const WORKING_RULES = `- Keep code concise, with brief inline comments only where useful.
- Verify with the project's own checks (tests, typecheck, lint), then live: start the app and exercise the changed behavior through its real entry point. \`agent-browser\` is on this machine for anything with a UI (\`agent-browser skills get core\` explains it; take a screenshot); an API or CLI change gets a real request or invocation. Skip the live test only when there is nothing to exercise — docs, a pure refactor — and say so. Add tests only for critical behavior; skip low-value assertions.
- Before opening the PR, have an independent subagent review your full diff with fresh eyes. Reviewers are often nitpicky and sometimes wrong, so you decide each finding, one of two ways. A real defect in what you changed — wrong behavior, a case the code mishandles, a test that does not test what it claims — gets fixed now; writing it down as a follow-up ships a bug you know about. Anything else — style, a preference, a suggestion outside the issue's scope, a change not worth its risk — gets dismissed with a sentence saying why. Do not restyle working code to satisfy a reviewer's taste. The PR lists each finding and its disposition in a line apiece.
- End the PR description with a **Verification** section: every check you ran and what it showed, and every check you did not run with the reason — not applicable, out of time, or the machine could not do it (a tool missing, a service unreachable). The factory reads that section to fix its own environment; a gap you leave unmentioned stays.`;

export function implementPrompt(task: Task): string {
  return `Implement the GitHub issue below and open a PR that resolves it (reference "Closes #${task.issueNumber}").

How we like to work in this repo:
${WORKING_RULES}

## Issue #${task.issueNumber}: ${task.title}
${task.url}

Read the issue at that URL, comments included — do not work from the title alone. The factory's most recent groom comment there (🏭 Factory groom) may end with a "Factory grooming notes" section: that is scoping direction, not a suggestion. Build what it scopes and leave out what it leaves out.`;
}

/**
 * The simplification agent: the counterweight to everything else the factory
 * launches. It is handed no issue — the work is to find the accretion, not to
 * act on a report of it — and the factory's own merged PRs as the first place to
 * look. The line-count rule is stated because the controller enforces it: a
 * simplification that adds code is closed before a human sees it.
 */
export function simplifyPrompt(opts: { recentPrs: string[]; declinedPrs: string[]; budget: RunBudget }): string {
  const declined = opts.declinedPrs.length > 0
    ? `\n\n## Simplifications a human already declined\n\nDo not propose these again.\n\n${opts.declinedPrs.join('\n')}`
    : '';

  return `You are the counterweight to the agents that build this repo. Autonomous implementers accrete complexity: each PR is locally reasonable, and the sum stops being something a person can hold in their head. Your job is one PR that makes this codebase simpler and smaller — or an honest report that there is nothing worth a reviewer's time.

Read the code first. The factory's recently merged PRs below are where the newest complexity most likely is, but go wherever it actually is. You are looking for:
- Abstractions with one caller, layers that only forward, interfaces with one implementation, options nothing sets.
- Legacy, fallback, and compatibility paths nothing reaches any more. Check callers, config, and data before calling one dead, and say what you checked.
- Hand-rolled versions of what the SDK, framework, or standard library already provides — an agent loop the SDK ships, a retry helper, a parser for a format that has a library.
- Two implementations of one idea; features nobody asked for; dead code and the tests that exist only to exercise it.

The one rule the factory checks itself: **the PR must remove more lines than it adds**, as GitHub counts them over the whole diff. One that does not is closed before a human sees it. So do not simplify by adding — no helper to replace three plain lines, no test asserting a deleted thing is gone, no comment describing what used to be there, no reformatting. Deleting is the point. If a change needs more code to be simpler, it is not the change for this PR.

Behavior the code still needs is preserved; what you remove is what you have shown nothing uses. Pick one theme a reviewer can hold in their head — related removals are fine, a grab bag is not — and make it big enough to matter: you have about ${opts.budget.maxRunMinutes} minutes to find it, cut it, verify what remains, and open the PR.

How we like to work in this repo:
${WORKING_RULES}
- The live test here exercises the behavior you kept, through the code you simplified.

The PR description says what was removed, why nothing needs it, and the line count. Open no PR when there is nothing worth a reviewer's time — a padded one costs a human review, and one that grows the code is closed anyway.

## Recently merged factory PRs

${opts.recentPrs.join('\n') || '(none yet)'}${declined}`;
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
  return `You own the environment the factory's coding agents run in. They are Cursor cloud agents working on this repo, and their machine is whatever \`.cursor/environment.json\` at the repo root configures — an install command, a dashboard snapshot, or a Dockerfile build. There may not be one yet, in which case they get Cursor's automatic setup. Whatever it is, it is expected to carry \`agent-browser\` — a headless-Chrome CLI installed from its GitHub release binary, needing no Node — because implementers are asked to live-test what they build with it.

Below are pull requests the factory's implementers opened. Read each one — the description, and the diff where you need it. You are looking for one thing: **a check the author would have run and could not, because the machine lacked something.** They say so plainly, in the PR's Verification section: a live test skipped because the browser was missing or broken is exactly that.

If you find a gap the environment can close, close it. Commit \`.cursor/environment.json\` and any Dockerfile it needs, change nothing else, and open a PR. Two things worth knowing:

- Docker is available to cloud agents but not on the default image. Installing \`docker-ce\` is not enough on its own: the daemon needs the \`fuse-overlayfs\` storage driver and \`iptables-legacy\`, and the \`ubuntu\` user needs to be in the \`docker\` group. Cursor documents the working Dockerfile at https://cursor.com/docs/cloud-agent/setup — follow it rather than improvising.
- Build the smallest environment that unblocks the checks you actually saw blocked. A general-purpose developer image costs every future agent its startup time, and you can add to this file again next week.

**Not every gap is yours to close.** A check that needs an artifact which does not exist yet at review time, or a credential the factory does not hold, is not an environment problem — the implementer verified the wrong thing, and the honest fix is a different check. When that is what you find, say what should have been verified instead and open no PR. Do not install your way around it.

Open no PR when nothing was blocked; that is the expected outcome most of the time, and a needless PR costs a human review. Whatever you write is posted back onto the PRs you read, so write it to the humans reviewing them.

## Pull requests

${prUrls.join('\n')}`;
}
