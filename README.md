# conveyor

An opinionated software factory: agents groom your backlog, one PR is in flight
at a time, and humans merge. Cursor cloud agents do the coding — or Claude Code
sessions on the machine running the tick, see [Workers](#workers) — and this repo owns
only the **factory policy** — what is worth building, when work happens, which
issue is admissible, verification requirements, review policy, the
human-approval boundary, and run/outcome telemetry.

## The opinions

Plenty of tools point an agent at a backlog. This one takes positions:

- **Grooming is a gate on the backlog, not on the agent.** An autonomous
  implementer handed a bad issue produces a confident bad PR. So issues are
  vetted against product-direction principles *before* anything is built, and
  nothing unvetted is ever implemented.
- **State lives in the issues, not in a database.** The verdict is a label; the
  factory's reasoning is a comment it signs; say anything new on the issue and it
  gets re-reviewed. Nothing a human wrote is ever edited, and there is no state to
  migrate, back up, or drift.
- **A human merge is the throttle, and it is one number.** `maxConcurrentJobs`
  caps the jobs that exist at once — open factory PRs awaiting a human plus
  pipelines still running — and is therefore also the most pipelines a tick will
  start (default 1). Autonomy is widened by raising that number, not by adding
  machinery.
- **Short prompts; the model's judgment is trusted.** No forced output schemas
  beyond two one-line handoffs, no controller-orchestrated review gates, no
  evidence protocols. Prompt lines exist only where we are specifically
  opinionated.
- **An assignee is a stop sign.** An issue a human has taken is not the factory's to
  implement — it cannot tell "assigned and untouched" from "assigned and half-written
  locally", and guessing wrong wastes a person's work, not an agent's. It will still
  groom it, because a verdict costs the assignee nothing and may be useful to them.
- **Every change is tested live, and every PR says what was checked.** Unit tests stand
  in for nothing: the implementer starts the app and exercises the change through its real
  entry point, with `agent-browser` for anything that has a UI, and ends its PR with a
  Verification section listing each check it ran and each it did not, with the reason.
  The groomer budgets for that and may not scope it away to make an issue fit.
- **CI's verdict goes back to the agent, not to the reviewer.** A PR with a failing check
  is not finished work. The factory waits for the checks and, if one is red, hands the
  failing jobs back to the implementer that wrote the code — same agent, same branch —
  for one fix round. It judges whether the failure is its own; one that is red on main
  too is reported on the PR and left. Only then does a human see the PR, and the issue
  comment says if it is still red. This is not a review gate: the check is the repo's
  own, and the factory only relays it.
- **The factory owns the machine it builds on.** When an agent cannot verify its own
  change because the sandbox lacks something, that is the factory's bug, not the
  reviewer's problem. An agent reads the factory's own PRs and fixes the environment.
- **Something has to push the other way.** Autonomous implementers accrete complexity:
  every PR is locally reasonable and the sum becomes unwieldy. So one agent's only job
  is to remove code, in a simplification PR that must delete more lines than it adds or
  the factory closes it before a human sees it. A test proving something is gone, or a
  helper standing in for three plain lines, is not simpler.
- **Telemetry exists to earn autonomy.** Every groom, run, environment pass, and PR
  outcome is recorded so that "which classes of task can automerge?" becomes an
  empirical question, not a leap of faith.

## What one tick does

```
reconcile with GitHub: record the verdict on every factory PR that has closed, release the
   in-progress label on every issue nothing is working on any more
→ GROOM agents (up to groom.maxPerTick, in parallel; epics, then blockers, then oldest
   first): vet issues against
   principles.md — "groomed" or "needs-work", recorded as a label, alongside a comment
   giving the conclusion, why, and any coding-level notes (the issue is never closed).
   An issue carrying the repo's epic label is groomed as a DIRECTION instead: the agent
   settles its open decisions in the comment and writes its first children, which the
   factory files under it. An unlabelled issue the groomer finds to be a direction rather
   than a PR is given that label and groomed as an epic in the same tick. A verdict blocked on another issue names it, and is revisited
   the tick after that issue closes
→ SIMPLIFY agent, alongside the implementation below: reads the codebase, starting from
   the factory's own merged PRs, and opens one PR that removes more code than it adds —
   abstractions with one caller, fallback paths nothing reaches, hand-rolled copies of
   what the SDK ships. A PR that grows the code is closed by the factory, unseen. One
   open at a time; a commit the last pass already judged is not looked at again
count the jobs already in flight (open factory PRs + running pipelines)
   → no free slot under maxConcurrentJobs? stop here
for each free slot:
   → take the OLDEST groomed issue by number (minus factory:wip claims, issues assigned
      to a human, and the picks made earlier this tick), except that a groomed issue
      labelled factory:blocker comes first however new it is. With selector.enabled, a
      SELECTOR agent instead gets LINKS to those issues — only the blockers, while any
      stand — reads them, and picks the best-defined one by judgment — no scores, no
      weights, no veto
   label the pick factory:wip
→ handoff to a FRESH implementer agent per pick, running concurrently, each with a
   short workflow prompt and the issue LINK (not its text — the agent reads the
   issue itself, notes and all)
wait for each PR's checks. A red check goes back to the SAME implementer, once, with
   the failing jobs' links: fix it if it is yours, say so on the PR if it is not
label the resulting PRs `factory`, comment on the issues, record telemetry
   → a run that ends with NO PR, or runs out of worker.maxRunMinutes, retracts the
      groom verdict: the issue is relabelled needs-work with the agent's report
→ ENVIRONMENT agent, last, so the PRs just opened are in front of it: reads the factory
   PRs it has not read yet, looking for a check the implementer could not run, and fixes
   .cursor/environment.json in the target repo so the next one can. Opens a PR only when
   it finds a gap it can close; one open at a time. A gap that is the repo's, not the
   machine's, is filed as an issue labelled factory:blocker, which puts it at the front
   of both queues above. Cursor worker only: local agents fix
   their own machine as they go
stop — a human merging or closing a PR is what frees the next slot
```

Grooming sits ahead of the capacity gate on purpose: it produces no code, so a PR
awaiting review is no reason to stop vetting the backlog. Nothing is implemented until
it has been groomed, which makes the pipeline self-throttling — an empty groomed set
means the factory idles rather than picking something unvetted.

Agents get links, not excerpts. No prompt pastes an issue's text, truncated or
otherwise: the agent opens the issue and reads what is actually there — the comments,
the groom notes, whatever a human added since. An excerpt is a second, staler copy of
the issue that the prompt author had to decide how to cut.

## One judge of size

"Is this one PR?" is asked exactly once, by grooming, and it is asked with the real
constraint in hand: the groom prompt states the implementer's run budget
(`worker.maxRunMinutes`), that it is a single fresh agent, and that it can use
subagents. Nothing downstream asks again. By default there is nothing downstream to
ask: a free slot takes the oldest groomed issue, and the only thing between grooming
and the implementer is a label. The optional selector agent (`selector.enabled`) ranks
rather than re-vets, and must always pick one — a selector that could decline would be
a second gate with no record of its verdict, and a factory whose two gates disagree
stalls forever on the same issue with the same log line.

The selector is off by default because it costs more as the groomed backlog grows —
one read of every groomed issue per free slot — without changing what lands. Grooming
decided each issue is buildable; the order they are tried in is not what the attempt
tests. Oldest first also means a stale groomed verdict is the next one tested rather
than the one skipped forever.

What tests the groom's judgment is the attempt. An implementer that finishes without a
PR, or runs out of its budget, has produced the one piece of evidence that matters, so
the factory retracts the verdict: `factory:groomed` comes off, `factory:needs-work`
goes on, and a comment carries the agent's report. That comment is not a new groom
stamp, so the fingerprint still points at what the groom read — the issue is groomed
again when a human replies or edits, and that groom is told to weigh the failed
attempt. Failures that say nothing about the issue (a worker error, a cancelled run, a
GitHub hiccup) only release it for a later tick.

## Grooming

Grooming is the one place the factory is opinionated about **what** to build. It is not
a gate on the agent — it is a gate on the backlog. An autonomous implementer handed a
bad issue produces a confident bad PR, and no amount of agent autonomy fixes an issue
that should not be built. A groomed issue's implementer is in fact *less* boxed in,
because the scoping argument already happened upstream.

Grooming works **oldest issue first**, with epics ahead of everything. Issues are filed
in roughly dependency order — what an issue builds on was usually filed before it — so
the oldest pending issue is the one whose verdict the most other issues rest on. A stale
old issue still costs a groom, but its `needs-work` is a real answer about the backlog,
and the newer issues that assumed it are then judged against that answer rather than
ahead of it.

One more tier sits between the epics and the rest: **blockers**. An issue labelled
`factory:blocker` is a defect that stops the factory's own implementers verifying their
changes — a test script that leaves the database empty, a shipped config that rejects the
app's own calls. The environment pass files these from the factory's PRs (see
[The environment](#the-environment)); a human can label
one too, or remove the label to demote it. Every PR opened while a blocker stands hits it,
so it is groomed ahead of the backlog and, once groomed, implemented ahead of it, however
new its number. The label is an ordering claim and nothing more: the groomer still judges
the issue, can still say `needs-work`, and the implementer's attempt still tests the
verdict. It does not skip the gate; it goes to the front of the line for it.

`principles.md` holds the product-direction principles grooming judges against. Its
first section, *What the product is*, is the short list of settled commitments an epic's
direction is checked against before anything else; the rest is about the shape of a
change. They are deliberately factory-local: they never reach the implementer, which sees
only coding-level direction. That separation is the point — product direction is decided
at grooming time, not at coding time.

**State lives in the issue, not in a local file.** The verdict is the
`factory:groomed` / `factory:needs-work` label — the thing you already read when
browsing the issue list, and can already change. Nothing parses prose to find it.

What a label cannot carry is *what was groomed*, so every verdict — pass or fail —
is also a comment the factory posts under its own name, over one invisible line:

```
<!-- factory-groom sha=a1b2c3d4e5f6 -->
🏭 **Factory groom — groomed.** An agent can pick this up as written. Edit the
description or reply here and it gets reviewed again on a later tick.

…why, in the factory's own words…

## Factory grooming notes
Stay inside services/worker; reuse Settings rather than adding a second validator.
```

The factory writes comments and never edits a description: who wrote what stays
legible, and its conclusion is timestamped in the issue's own history.

`sha` fingerprints the human-authored content — the description plus every comment
the factory did not write — so a mismatch means a human has said something since.
The verdict is void and the issue is groomed again on the next tick. That is the
whole answer to "what if the issue changes later": **edit it or reply to it and it
gets re-reviewed**, whether it previously passed or was rejected. It costs no extra
API calls, since bodies and comments are fetched together, and it is the only signal
that survives the factory's own labelling — which bumps every timestamp GitHub
would otherwise offer.

The two records answer different questions, so they cannot contradict each other:
the label says whether an issue passed, the fingerprint says whether that answer is
still about the issue as it stands. **The label alone decides what may be
implemented; the fingerprint only decides what gets looked at again.** So every
`factory:groomed` issue is implementable, and one that has drifted is both
implementable now and queued for a re-review — a verdict stands until something
replaces it.

Absence of a fingerprint is not evidence against a verdict, only absence of evidence
for it. An issue labelled by an older version of the factory, or by hand, keeps its
verdict and gets re-groomed on a later tick. That does mean labelling an issue
`factory:groomed` yourself makes it implementable before it is vetted — the label is
the record, so it is also the override.

The tick is idempotent: run it as often as you like; it starts work only in the slots
`maxConcurrentJobs` leaves free, counting open factory PRs and running pipelines alike.
`maxConcurrentJobs: 1` is the strict one-at-a-time factory. At 2, a tick with both slots
free takes two groomed issues and runs two implementers concurrently — they work on separate
branches, so the only collisions are ones a human resolves at review time. Crashed
pipelines are detected via stale records in the local `telemetry/current-runs.json`
(> `staleRunHours`), recorded as aborted, and cleaned up, so a crash cannot leak a slot.

## Epics: where direction comes from

Grooming one issue at a time has a blind spot. Every capability that needs more than one
PR before it delivers anything has a first PR that is, on its own, dead code — a planner
whose plan nothing executes, a contract with one implementation. Judged alone, that issue
fails, and so the capability never starts. A factory with only that filter drifts toward
maintenance: fixes, deletions, small hardening, and nothing anyone would call a direction.

An **epic** is how direction gets in. It is an ordinary issue carrying the repo's own epic
label (`labels.epic`, default `type:epic`). Nobody has to apply the label: the ordinary
groom has a third verdict, `epic`, for an issue that turns out to be a direction rather
than a PR — several PRs before anything is delivered, with decisions that bind them all.
The factory labels it, says why in a comment, and grooms it again as an epic in the same
tick. Size alone is not an epic; an issue that is merely too large is `needs-work`. The
factory grooms an epic with the same agent and the same principles, but the question
changes: not "can one PR land this" but "is this worth building toward, and can its
shape-changing decisions be settled here". The groomer settles them — which engine first, a plain string
or a modelled entity, the existing mechanism or a new one — and records each default, why,
and what reversing it would cost, in the groom comment. That comment is the record the
children are built against.

**The groomer asks a human only for the decisions that need one:** irreversible ones, legal
or licensing exposure, or anything that widens what the system may do on its own. Those are
`needs-work` with the one decision named. Everything else is a default a human can veto
the way every verdict here is vetoed: reply on the epic, and it is groomed again with the
reply in view. Nothing waits for an approval nobody asked for.

**A groomed epic's children are the work.** The groomer writes the first slice — the issues
that can start against the code as it stands or against a sibling in the same slice — each
one PR by the usual standard, in fenced ```` ```child ```` blocks. The factory files them
under the epic, each opening with a `Part of #N` line, inheriting the epic's labels minus
the factory's own. Each child is then groomed on a later tick like any issue, with one
difference the groom prompt spells out: the epic's decisions are its premise, so the
groomer judges shape and size and does not re-argue whether the capability should exist.
Later slices are written when the epic is groomed again after the first has landed.

**A groomed epic is never implemented.** It carries the same `factory:groomed`
label as an implementable issue, because grooming is the one verdict mechanism here, but
`admissible(..., 'implement')` drops anything with the epic label. What gets built is the
children.

**Blocked verdicts revisit themselves.** A child that cannot start until its epic is groomed,
or until a sibling lands, is `needs-work` with a `BLOCKED: #N` line in the groomer's reply.
The factory carries that into the stamp — `<!-- factory-groom sha=… blocked=#N -->` — and
treats the verdict as stale the tick after the blocker clears, exactly as if a human had
replied: a sibling clears when it is no longer open, an epic clears when it is groomed,
since an epic never closes while its children are being built. A blocker that is not an
open issue — a pull request, usually — is looked up on its own and held open until GitHub
says it is closed, so the verdict does not read as cleared, and get groomed again to the
same conclusion, every tick. So a first-slice child
blocked on its sibling is groomed again, unprompted, once the sibling merges. The only
state is in the issue, as always. Epics are groomed ahead of everything else in a tick,
because their children are newer than they are by construction and grooming a child
before its epic only produces a verdict blocked on it — and since a tick's grooms run in
parallel, a child whose epic is itself waiting for a groom is left out of that tick
entirely rather than groomed beside it.

**Children follow the epic's record.** A child's verdict is judged against the decisions in
its epic's groom comment, so the stamp names that record — `<!-- factory-groom sha=…
premise=#N@<hash of the epic's groom comment> -->`. When the epic is groomed again, the
hash no longer matches and every child judged against the old record is stale: each is
re-groomed against the record as it stands, told that the epic is what brought it back, and
asked what changed for it, which may be nothing. A child already claimed by an implementer
is not interrupted; its PR is reviewed like any other.

**An epic reviews itself when its slice lands.** The epic's stamp names the children its
verdict knew about — `children=#a,#b`, plus the ones the factory filed for it — and the
verdict goes stale once none of them is open. That re-groom is where the next slice of
children gets written, so a capability keeps moving without anyone remembering to ask. A
child a human closes as rejected counts as landed for this purpose, which is what you want:
the groomer sees the closure and writes around it.

**Direction changes in one place, and it ratchets.** A revised design document is not a
change of direction. A reply on the epic is — one that links the revision and names the
decisions it disagrees with. The epic is then groomed again with that reply in view, and the
groomer is told the record ratchets: a settled decision stands unless the reply names it,
the code has moved from under it, or it now pulls against the principles, and a decision a
merged or in-flight child relies on is reversed only when the reply asks for that in so many
words, with the cost in existing code stated. The children then follow, as above. This is
what keeps a document that is rewritten weekly from becoming weekly whiplash for the work:
every reversal is a deliberate, attributed act on the issue the work hangs from, and its cost
is written down where the person making it can see it.

The whole flow, for the next design document (`.claude/skills/doc-to-epics` walks it): file
one issue per direction it proposes with the epic label, written so the issue is the record —
what should become true, how the author means it to work, the decisions and their proposed
defaults, all in the issue's own words, since the document is usually internal and the
agents never see it. A document that is a plan, a schedule, an org chart and a product
proposal at once yields several epics, and the plan and the schedule are not among them.
Run the tick; the design review is the groom. When the document is revised, reply on the
epics it changes with the change stated in full; do not file a new one.

## The environment

An implementer that cannot verify its own change says so, plainly, in the PR it opens:

> Could not run the job itself here: it pulls the just-built GHCR images, and this
> environment has no Docker.

The implementer is required to write that section — every check run, every check not run,
and why — so a blocked live test cannot go unmentioned. That is a real finding about the
factory, and until it is acted on it is only prose in a PR body. The environment phase acts on it. An agent is handed the factory PRs it has not
read yet and reads them itself, looking for one thing: **a check the author would have run
and could not, because the machine lacked something.** If the environment can close the
gap, it commits `.cursor/environment.json` (and any Dockerfile it needs) to the target repo
and opens a PR that changes nothing else.

**Nothing is parsed, in either direction.** The implementer is not asked for a structured
report and its reply is not scanned for one — deciding whether a PR describes a blocked
check is a judgment call, so it lives in an agent, handed links the way grooming is handed
an issue link. And the pass's own verdict is the branch it pushed: a PR means it found a
fixable gap, no PR means it did not. That is the same handoff the controller already reads
from an implementer, so the phase adds no new grammar to the factory. The one exception is
below, and it borrows the groomer's grammar rather than adding its own.

**Some gaps are the repo's, and those get filed.** An implementer sometimes reports, under
the same heading, that the repo as shipped did not work — the example config rejects the
agent layer's own service-to-service calls, say. The image cannot fix that and neither can
a different check; it is a defect, and the fix is a change to the repo. The agent used to be
able to say only that: it called one CSRF bug "worth its own issue" on two PRs in a row,
and nobody filed it. Now it writes the defect as a fenced ```` ```issue ```` block — the
shape the groomer already uses for an epic's children — and the factory files it, labelled
`factory:blocker`, with the PRs it came from named at the top. The groomer judges it like
an issue a human wrote; the environment agent's job ends at naming it. It is told to check
open issues and its own recent verdicts first, so one defect reported by several
implementers is filed once.

The label is what keeps the finding from sinking. An oldest-first queue puts a defect filed
last night behind everything filed before it, and the first such issue the factory filed
sat unlabelled behind twenty ungroomed and eighteen groomed issues while every new PR
hit the same broken test database. An implementer already hit it, so every implementer
after it will too: it is a premise for their verification the way an epic's verdict is a
premise for its children, and both queues put it ahead of the backlog for the same reason.
Filing an issue rather than a PR is still right — the environment agent read a report, it
did not hit the bug, and a PR from it would be a second implementer routed around the
groom — so what changed is where the issue lands, not who builds it.

The implementer's Verification section does keep **Blocked by the machine** as its own
heading, apart from checks that were not applicable or ran out of time. That is not a
format the factory parses; it is so the reviewer and the environment agent both find the
one line that matters without sorting it out of the others.

**The reference machine is the repo's own CI.** The workflows under `.github/workflows`
already say what has to be installed and running before the repo's checks can pass, so the
agent is told to hold the environment to that: a suite an implementer skipped because its
runner was not installed, or a database that was not up, is a gap, and so is a
`pip install` every implementer has to run before anything works. Our first version asked
only for *blocked* checks and warned against a general-purpose image, and the agent applied
that faithfully — it called "installed the deps myself" an inconvenience, PR after PR, while
an implementer down the line skipped the Python integration suite over exactly that. Beyond
what CI needs the warning still holds: a tool no workflow installs is not the agent's to add.

The agent is also shown its own recent verdicts, one per PR it has read. A gap that shows
up as a shrug in every PR is invisible to a reader handed one PR at a time; this is where
it is seen whole.

**Not every gap is the environment's to close**, and the prompt is specific about it. A
check that needs an artifact which does not exist yet at review time, or a credential the
factory does not hold, is not an environment problem — the implementer verified the wrong
thing, and the honest answer is a different check. The agent says so and opens no PR. Left
out, this is the phase's obvious failure mode: an agent that installs its way around
problems that were never about the environment.

**Credentials are the one gap closed from the factory's side, not the environment's.**
`worker.agentEnv` in `factory.config.json` names environment variables the tick machine
holds — an LLM provider key, say — each with a description of what it is for. Every
implementer gets the set ones in its shell (Cursor: session-scoped `envVars` on the VM,
deleted with the agent; `claude-code`: inherited) and a **Credentials in your environment**
section in its prompt naming them, so the live test that needs the real model gets run
rather than filed under blocked. The environment agent is told the same list, so "no API
key here" reads as the implementer's skip, not the machine's. The values live in `.env`
locally and as Actions secrets in CI; one that is unset where the tick runs is logged and
left out, never an error. Prompts carry names and descriptions only.

Either way the finding is posted back onto the PRs that produced it, which is where the
human who hit the blocked check is looking.

**Environment PRs are their own queue, one deep.** They do not count against
`maxConcurrentJobs` and cannot collide with an implementer — one touches only `.cursor/`,
the other only product code — so a full review queue never leaves the agents' machine
broken. The cost is honest: it is a second thing that can be awaiting your review. Set
`environment.enabled` to `false` to turn the phase off entirely.

**The phase belongs to the Cursor worker.** `.cursor/environment.json` describes the
machine Cursor's cloud agents get. With `worker.kind` set to `claude-code` the agents run
on the machine running the tick, with permission to install whatever they lack, so there
is no environment file to write and the phase reports itself skipped.

**Every input comes from GitHub, none from telemetry.** The factory PRs are the ones
carrying the factory label; a PR has been read when the environment agent's comment is on
it, which the pass posts on every PR it reads anyway; and the environment last changed when
the newest environment-labelled PR merged. Telemetry records each pass and decides nothing.
The first version read run records instead, and a tick whose telemetry failed to persist —
the GitHub Actions runner, for a week — re-read the same two PRs every day while never
learning the newer ones existed. GitHub is where the PRs are; asking it is correct from any
machine, and a pass that fails before commenting leaves its PRs unread, so they come back
around without any bookkeeping.

**A merged environment PR voids every report written before it.** A report is a claim
about the machine the agent ran on, so once that machine changes the claim is about
something that no longer exists — the same move the groom fingerprint makes when a human
replies to an issue. Without this the phase re-fixes what it just fixed: our first
environment PR merged, and the next pass was handed seven reports of "no Docker" all
written on the pre-Docker machine, and dutifully added Docker again. A PR *opened* before
the change was written on the old machine, so its creation time is the cutoff.

Voided reports are dropped, not deferred. If the gap one describes still exists, the next
implementer hits it and says so in a PR opened after the change, and that one is read.
Only evidence about the current machine counts.

The phase runs at most once per tick, only when there are unread factory PRs with reports
about the current machine and no environment PR already open, and reads at most
`environment.maxPrsPerPass` of them, newest first. The old tail is starved on a busy
factory, deliberately: an unread old PR costs nothing, a stale environment costs every run.

## Simplification

Everything else in the factory adds code. Grooming lets more of the backlog through,
implementers land it, the environment phase makes sure it can be verified — and every
one of those PRs is locally reasonable. The sum is not. Our first week of merged factory
PRs ran roughly +260/−15, +370/−5, +490/−130: an autonomous codebase accretes helpers,
fallback paths, hand-rolled loops the SDK already ships, and tests for all of it, until a
person can no longer hold it in their head and progress slows to match. The
simplification phase is the counterweight: one agent whose only job is to take code out.

It is handed no issue. Finding the accretion is the work, so the agent reads the codebase
itself, pointed first at the factory's most recently merged PRs — where the newest
complexity most likely is — and told what to look for: abstractions with one caller,
legacy and fallback paths nothing reaches, two implementations of one idea, features
nobody asked for, and hand-rolled versions of what the framework provides. It has the
same run budget as an implementer, so the PR can be substantial, and it works to the same
rules: verify live, get a subagent review, report every check in the PR.

**The one rule the factory enforces itself is that the PR must remove more lines than it
adds**, as GitHub counts them over the whole diff. This is enforced mechanically, not
just asked for, because the failure mode is specific and common: an agent asked to
simplify introduces an abstraction, or deletes a path and adds a test asserting the path
is gone, and calls the result cleaner. The controller reads the PR's additions and
deletions — one number GitHub already computes, no prose parsed — and a PR that grew the
code is closed with the numbers in a comment before any human spends a review on it. The
branch is left in place; the telemetry records it as `grew`. If that becomes common, the
prompt is what to tune.

Simplification PRs are their own queue, one deep, like environment PRs: they carry
`factory:simplify` rather than `factory`, so they never spend an implementer's slot. They
*can* touch the same files as an in-flight implementer — that is the same collision two
concurrent implementers can have, and it is resolved the same way, by the human at review
time. A pass that reached a conclusion on a commit — opened a PR, found nothing, or grew
the code — is not repeated until the default branch moves, so an idle repo does not buy a
fresh 90-minute search every day. A simplification a human closes unmerged is recorded
like any other rejected PR, and the next pass is handed its link and told not to propose
it again. Set `simplify.enabled` to `false` to turn the phase off.

## Deploying

A deployment is a fork (or "Use this template" copy) of this repo that commits
its own policy on top:

```bash
npm install
cp factory.config.example.json factory.config.json   # point it at your target repo
cp principles.example.md principles.md               # then rewrite it — highest-leverage file here
$EDITOR factory.config.json                          # set groom.principlesFile to principles.md
cp .env.example .env       # Cursor API key (cursor.com/dashboard → API Keys), or nothing for claude-code
gh auth status             # gh must be authenticated with repo scope on the target repo
```

Commit `factory.config.json` and your `principles.md` to your fork — they *are*
your deployment. Upstream ships only `*.example` versions of both and gitignores
`telemetry/`, so your policy never collides with an engine change:

```bash
git remote add upstream https://github.com/samarmstrong/conveyor.git
git pull upstream main     # engine updates; your policy files are untouched
```


### Workers

`worker.kind` in `factory.config.json` names the runtime the factory hands its prompts
to. Everything else — prompts, phases, labels, telemetry — is the same either way.

- **`cursor`** (default): Cursor Cloud Agents. Each agent gets a fresh VM, clones the
  repo itself, and opens the PR itself. Needs `CURSOR_API_KEY`. The
  [environment phase](#the-environment) maintains its machine.
- **`claude-code`**: Claude Code sessions on the machine running the tick. The worker
  clones the target repo at the tick's pinned commit into `telemetry/workspaces/<session>`,
  puts the agent on a `factory/…` branch, and runs `claude -p` there with
  `--dangerously-skip-permissions` — the same latitude a Cursor agent has in its VM, but
  on this machine, so run it somewhere you would let an agent run. The agent pushes and
  opens the PR with `gh`; a CI fix round is `claude --resume` in the same clone. Auth is
  the machine's claude.ai login, so runs draw on the subscription rather than API
  keys; where there is no browser, `claude setup-token` prints a one-year token for
  `CLAUDE_CODE_OAUTH_TOKEN`. The agents see only the MCP servers the target repo's
  `.mcp.json` declares, never this machine's. `FACTORY_CLAUDE_BIN` points at the
  executable when `claude` is not on PATH.

`worker.model` is written once, in Cursor's shape, and translated for Claude Code:
`params.context: "1m"` becomes the `[1m]` suffix and `params.effort` becomes `--effort`;
`thinking` is dropped (Claude Code has no flag for it). Cost in the telemetry for `claude-code` runs
is Claude Code's estimate of what the run would have cost on the API, not a bill.

**Falling back.** `FACTORY_WORKER=claude-code npm run factory -- run` overrides
`worker.kind` for one tick; in Actions, the manual dispatch has a `worker` input that does
the same. That is the move when the Cursor account is out of usage: nothing else changes.

## Commands

```bash
npm run factory -- run             # one tick (the daily entry point)
npm run factory -- run --dry-run   # grooming/backlog state + the exact prompts, launch nothing
npm run factory -- groom           # run just the grooming phase
npm run factory -- select          # run just the selector agent over the groomed issues (even with selector.enabled off)
npm run factory -- env             # run just the environment phase over the unread factory PRs
npm run factory -- simplify        # run just the simplification phase: one PR that removes more than it adds
npm run factory -- status          # grooming progress, capacity, in-flight jobs, recent telemetry
npm run factory -- abort           # abandon every stuck pipeline (cancels the runs where the worker can)
npm run factory -- abort --issue 42  # ...or just the one working issue #42
npm run check                      # typecheck + unit tests
```

## Daily trigger

Two options; both just invoke the idempotent tick.

**Local (launchd, macOS):** copy `contrib/com.example.conveyor.plist` to
`~/Library/LaunchAgents/`, adjust paths, then `launchctl load` it.

**GitHub Actions:** enable `.github/workflows/factory.yml` in your fork (daily
cron + manual dispatch). Requires `FACTORY_GH_TOKEN` (a PAT with `repo` scope on
the target repo — the default `GITHUB_TOKEN` is scoped to the fork and cannot
touch the target repo; the `claude-code` worker's agents push with it too) plus
the worker's own secret: `CURSOR_API_KEY` for `cursor`, `CLAUDE_CODE_OAUTH_TOKEN`
for `claude-code`. Each credential named in `worker.agentEnv` is a secret of the
same name, added to the tick step's `env`. The dispatch form's `worker` input
overrides `worker.kind` for that run. The tick step is skipped automatically
when no `factory.config.json` is committed, so the workflow is inert in the
upstream repo.

## Policy knobs

- `principles.md` — **what is worth building.** The product-direction standard
  grooming enforces. This is the highest-leverage file in the repo; editing it changes
  what the factory will and will not build.
- `factory.config.json` — target repo, `worker.kind` (`cursor` or `claude-code`, see
  [Workers](#workers)), model (`null` = the worker's default; Cursor's list is
  `GET https://api.cursor.com/v1/models`, Claude Code takes any alias or id it accepts),
  poll interval, max run minutes, `worker.agentEnv` (credentials handed to every agent,
  see [The environment](#the-environment)),
  `groom.maxPerTick` (how much backlog to vet per tick), `maxConcurrentJobs` (how many
  jobs may be in flight at once — the whole implementation throttle), stale-run cutoff,
  labels.
- `factory.config.json` → `labels.epic` — the repo's own epic label (default `type:epic`).
  Issues carrying it are groomed as direction and never implemented; see "Epics" above.
- `factory.config.json` → `labels.blocker` — (default `factory:blocker`) an issue that
  blocks the agents' own verification. Groomed and implemented ahead of the rest of the
  backlog; the environment pass applies it to the repo defects it files, and a human may
  apply or remove it. Ordering only: the groomer still judges the issue.
- `factory.config.json` → `assignedIssues` — whether each phase may act on an issue a
  human has assigned to themselves. Defaults to `{ "groom": true, "implement": false }`:
  vetting an assigned issue costs its assignee nothing, implementing one collides with
  them. Set `implement` to `true` for a repo where assignment means triage rather than
  intent.
- `factory.config.json` → `environment` — `enabled` (default true) and `maxPrsPerPass`
  (default 3): the phase that owns the cloud-agent environment. Off means the factory
  keeps opening PRs whose verification was blocked and never fixes the cause.
- `factory.config.json` → `simplify` — `enabled` (default true): the phase that removes
  code. Off means the factory only ever adds.
- `factory.config.json` → `selector` — `enabled` (default false): whether an agent ranks
  the groomed issues before each implementer run. Off, the oldest groomed issue is
  implemented next; see [One judge of size](#one-judge-of-size) for why that is the
  default. `maxCandidates` (default 100) bounds the open-issue fetch either way.
- `src/prompts.ts` — all five prompts (groom / selector / implementer / environment /
  simplify), each a few lines. The implementer and simplifier share one block of working
  rules so a simplification is held to exactly the standard the code it removes was built to. Add lines only for specific opinions where the model's default behavior isn't
  what you want. **Widening autonomy later = widening this policy, not adding
  machinery.**
- `src/selector.ts` — only the mechanical bits: filter the claims (`factory:wip`, and
  assignees when `assignedIssues` says so) and parse the selector's `SELECTED: #N`
  handoff line.
- `src/groom.ts` — only the mechanical bits: the verdict labels, the fingerprint that
  dates them, the backlog filters, and `VERDICT`-line parsing.
- `src/environment.ts` — only the mechanical bits: which factory PRs a pass has not read
  yet, which of their reports still describe the current machine, and why a pass is not
  running. No parsing at all.
- `src/simplify.ts` — only the mechanical bits: which merged PRs to point the agent at,
  which declined ones to warn it off, whether a PR shrank the code, and why a pass is not
  running.

## Telemetry

**GitHub is the source of record; telemetry is the record of what the factory spent.**
Nothing the tick decides is read from telemetry. Which issues are claimed, which PRs
closed, what the environment agent has read, what the simplifier was declined — all of it
is on GitHub, as labels, PR state, and the factory's own comments, and every phase asks
GitHub. The first version decided from telemetry, and a runner whose telemetry did not
persist — the Actions runner, for a week — re-read the same PRs every day and never
learned the new ones existed. A record can be lost without the factory doing anything
wrong; a decision cannot.

The one exception is deliberate: the simplification pass skips a commit the last pass
already judged, read from telemetry. Stale telemetry names an old commit and the pass
runs, so the worst a lost record can do there is cost one redundant pass.

The record itself is append-only JSONL at `telemetry/runs.jsonl`, kept on the `telemetry`
branch: only the tick writes it, nothing reviews it, and the org ruleset that requires a
PR for `main` has no business with it. The Actions tick fetches the branch before it
starts and appends its rows after. To read it locally:

```bash
git fetch origin telemetry && git show origin/telemetry:telemetry/runs.jsonl > telemetry/runs.jsonl
npm run factory -- status
```

Its rows:

- `groom` records: issue, verdict, whether notes were written, whether it was a
  re-groom after the issue changed, agent id, token usage, duration. For an epic, that
  it was one and how many children were filed; for a blocked verdict, the blocker.
- `run` records: issue, worker/model, implementer agent id (and the selector's, when one
  ran), start/end, outcome (`pr-opened`/`no-pr`/`failed`/`aborted`), token usage, duration.
- `env` records: which factory PRs the pass read, whether it opened a PR and which,
  agent id, token usage, duration. A failed pass records no PRs as read, so they are
  offered to the next one.
- `simplify` records: the commit the pass read, whether it opened a PR (`pr-opened`),
  opened one the factory closed for growing the code (`grew`), or proposed nothing
  (`no-change`), the PR's additions and deletions, agent id, token usage, duration.
- `outcome` records: per PR — merged or rejected, human change requests, human
  comment count, time to close, and which pipeline opened it (`implementer`,
  `environment`, or `simplify`).

Joining `groom` to `outcome` is the question worth measuring: do issues that carried
grooming notes get merged with fewer human change requests than ones that passed clean?
Joining `env` to the `run` records after it is the second: once an environment PR merges,
do the implementers that follow stop reporting checks they could not run? The `simplify`
records answer a third: what does the factory's net line count look like once something
is pushing the other way, and how often does an agent asked to simplify grow the code?

This is the dataset for deciding what V2 should be (e.g. automerge for classes of
tasks whose historical human-rejection rate is ~zero).

## Architecture

```
principles.md      what is worth building  ← factory policy (ships as principles.example.md)
src/types.ts       CodingWorker / WorkSource boundaries + telemetry records
src/worker.ts      CursorWorker (Cursor Cloud Agents v1 API) — the only Cursor-aware file
src/claudeCodeWorker.ts  ClaudeCodeWorker: a clone per session, `claude -p` in it
                   Every agent is pinned to one `startingRef`, resolved per tick
src/workSource.ts  GitHubIssueSource (incl. writing groom verdicts back to issues)
src/groom.ts       verdict labels + fingerprint, backlog filters, VERDICT parsing
src/environment.ts unread-PR bookkeeping + report freshness for the environment phase
src/simplify.ts    the shrink rule, what to point the simplifier at, when not to run it
src/selector.ts    wip + assignee filters, SELECTED-line parsing (mechanical only)
src/prompts.ts     groom + selector + implementer + environment + simplify prompts  ← factory policy
src/state.ts       capacity gate (open PRs + in-flight runs), outcome reconciliation
src/controller.ts  the tick
src/github.ts      thin `gh` CLI wrapper
src/telemetry.ts   JSONL groom/run/outcome log
src/cli.ts         run / groom / select / env / simplify / status / abort
```

Non-goals (V1, on purpose): custom agent runtime, custom sandboxes, multi-agent
framework, workflow engines, autonomous merging, persistent state machines. Parallelism
is one integer (`maxConcurrentJobs`), not a scheduler. A worker is one class implementing
`CodingWorker` (start, continue, await, usage, cancel) chosen by `worker.kind`; there are
two, and nothing outside them knows which runtime is coding.

## License

[MIT](LICENSE)
