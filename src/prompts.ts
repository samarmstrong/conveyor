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

If the issue says it is part of an epic, open the epic. An epic the factory has groomed — it carries the factory's groomed label and a 🏭 Factory groom comment — has settled the premise: do not re-ask whether the capability is worth having or whether its concepts should exist. Judge this issue on whether it is one correct PR toward the epic, and follow the decisions recorded in the epic's groom comment; they bind this issue's design. An epic that is not groomed lends its children nothing, and a child whose point depends on it is needs-work, blocked on the epic. The epic alone can bring an issue back here: if the epic's groom comment is newer than the factory's last verdict on this issue, the record this issue was judged against has changed. Judge it against the record as it stands now and say what that changes for this issue — which may be nothing.

When an issue is needs-work only because another open issue has to land first — its epic, or a sibling it builds on — say so and add one line after the verdict:
BLOCKED: #<issue number>
The factory reviews the issue again when that one closes, so there is no need to explain what would change.

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
 * Grooming an epic. Same agent, same principles, a different question: not
 * "can one PR land this" but "is this a direction worth building toward, and
 * can its open decisions be settled here". The groomer settles them — a
 * default, a reason, a reversal cost, all in the open — and writes the first
 * slice of children, which the factory files under the epic. A human is asked
 * only for the decisions that are irreversible, legal, or widen what the system
 * may do on its own; everything else is a default a human can veto by replying.
 */
export function groomEpicPrompt(task: Task, principles: string, budget: RunBudget): string {
  return `Groom GitHub issue #${task.issueNumber} — an epic — for the software factory.
${task.url}

An epic is a direction, not a PR. Read it there, comments included, and everything it links: a design document, earlier issues, whatever the author pointed at. Then read the code it concerns. You are reviewing, not implementing, so change nothing. Judge the direction against the product-direction principles below; they outrank how the author framed it, and the direction you settle on may be narrower than what the epic proposes.

Two verdicts:
- groomed — the direction is worth building toward and its shape-changing decisions can be settled here. Settle them. For each decision the epic leaves open, or gets wrong, state the default you chose, why, and what it would cost to reverse. Prefer the smallest choice that proves the seam: the lighter engine over the heavier one, the plain string over the modelled entity, the mechanism the repo already has over a new one. These decisions become the record the children are built against, so write them in the open, addressed to the author and to whoever grooms the children.
- needs-work — the direction pulls against the principles with no correct narrower direction inside it, or a decision genuinely needs a human: one that is irreversible, carries legal or licensing exposure, or widens the blast radius of what the system may do on its own. Name that one decision and what answering it unblocks; do not send back a list of questions a reasonable default would settle. A direction the principles reject is needs-work however well the epic argues for it.

On a re-review — the epic already carries a 🏭 Factory groom comment — that comment is the record its children were written and groomed against, and what brought you back is a human reply, a revised design it links, or a child that landed. Direction changed here costs the children real work, so the record ratchets: keep every settled decision unless the reply names it, the code has moved from under it, or it now pulls against the principles. A decision a merged or in-flight child already relies on is reversed only when the reply asks for that in so many words, and then your comment says what the reversal costs in code that exists. Say plainly which decisions changed and which stand, so the children are re-judged against the difference rather than re-argued from scratch.

A groomed epic is a premise its children inherit, so you also write the children: the first slice of issues the factory can build now. Each is one PR by the same standard as any issue here — a single fresh cloud agent with about ${budget.maxRunMinutes} minutes to read the issue, build the change, verify it live, and open the PR. Put each child in its own fenced \`\`\`child block: the first line is the title, the rest is the body, in the repository's own issue style, citing the files it concerns and saying what to reuse and what not to build. Children are not filed yet, so state a dependency on a sibling by describing it, not by number. Write only the slice that can start against the code as it stands or against a sibling in the same slice; later slices are written when this epic is reviewed again after these land. Issues that already name this epic as their parent are its existing children: read them, do not write them again, and write only what is missing — on a re-review that may be nothing. Write no children for a needs-work epic. The factory files them under the epic, each opening with a line that names it.

Everything else you write becomes the factory's comment on the epic.

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
- End the PR description with a **Verification** section in three parts. **Ran**: every check you ran and what it showed. **Did not run**: every check you skipped as not applicable or out of time, with the reason. **Blocked by the machine**: every check you could not run because this environment lacked something — a tool not installed, a service not up, a dependency you had to install by hand before anything worked — even if you then worked around it. Keep that last part separate and write "none" when it is empty: the factory reads it to fix its own environment, and a gap you leave unmentioned or file under the wrong heading stays.`;

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
 * than in a parser. It is also handed its own recent verdicts, because the gap
 * that matters most rarely reads as "blocked" in any one PR — every implementer
 * installs the project's dependencies itself, some skip a suite over it, and a
 * reader handed one PR at a time called that inconvenience for a week. The
 * Docker specifics are here because they are the one thing a model reliably
 * gets wrong — cloud agents can run Docker, but not on the default image and
 * not without the overlay/iptables workarounds.
 */
export function environmentPrompt(prUrls: string[], verdicts: string[] = []): string {
  const priors = verdicts.length > 0
    ? `

## Your recent verdicts

What you concluded on the PRs before these, newest first. Read them before the PRs below: a setup step every implementer repeats, or a suite more than one of them skipped, is one gap showing up in pieces, and this is where you see it whole.

${verdicts.join('\n')}`
    : '';

  return `You own the environment the factory's coding agents run in. They are Cursor cloud agents working on this repo, and their machine is whatever \`.cursor/environment.json\` at the repo root configures — an install command, a dashboard snapshot, or a Dockerfile build. There may not be one yet, in which case they get Cursor's automatic setup. Whatever it is, it is expected to carry \`agent-browser\` — a headless-Chrome CLI installed from its GitHub release binary, needing no Node — because implementers are asked to live-test what they build with it.

**The reference machine is the repo's own CI.** Its workflows under \`.github/workflows\` say exactly what has to be installed and running before this repo's checks can pass — the language toolchains at their pinned versions, the dependency install steps, the databases and queues declared as services. An implementer's machine should start where a CI job starts. If a check runs in CI and an implementer here had to install something, start something, or skip the check to get to it, that is the gap you close.

Below are pull requests the factory's implementers opened. Read each one — the description, and the diff where you need it. You are looking for **a check the author would have run and could not, or ran only after setting the machine up themselves, because it lacked something CI has.** They say so in the PR's Verification section: a suite skipped because its runner was not installed or its database was not up, a live test skipped because the browser was missing or broken, a "pip install" or "npm ci" the author had to run before anything else. The first two are blocked checks. The last is a tax every future implementer pays and some will skip under — treat it as the same gap.

If you find a gap the environment can close, close it. Commit \`.cursor/environment.json\` and any Dockerfile it needs, change nothing else, and open a PR. Three things worth knowing:

- Docker is available to cloud agents but not on the default image. Installing \`docker-ce\` is not enough on its own: the daemon needs the \`fuse-overlayfs\` storage driver and \`iptables-legacy\`, and the \`ubuntu\` user needs to be in the \`docker\` group. Cursor documents the working Dockerfile at https://cursor.com/docs/cloud-agent/setup — follow it rather than improvising.
- Services CI declares — Postgres, Redis, whatever the workflow's \`services:\` block names — belong in the environment's \`start\` command, brought up the way the repo's own compose file or test scripts bring them up, so they are ready when the agent's first command runs.
- Build to what CI needs, not beyond it. Every layer costs every future agent its startup time, so a tool no workflow installs is not yours to add; but anything a workflow installs before running tests is already paid for in CI and cheap here by comparison. You can add to this file again next week.

**Not every gap is yours to close.** A check that needs an artifact which does not exist yet at review time, a credential the factory does not hold, or a display or cluster no CI job has either, is not an environment problem — the implementer verified the wrong thing, and the honest fix is a different check. When that is what you find, say what should have been verified instead and open no PR. Do not install your way around it.

Open no PR when nothing was blocked and nothing had to be set up; a needless PR costs a human review. Whatever you write is posted back onto the PRs you read, so write it to the humans reviewing them.${priors}

## Pull requests

${prUrls.join('\n')}`;
}
