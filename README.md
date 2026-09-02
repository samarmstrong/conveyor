# conveyor

An opinionated software factory: agents groom your backlog, one PR is in flight
at a time, and humans merge. Cursor cloud agents do the coding; this repo owns
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
- **The factory owns the machine it builds on.** When an agent cannot verify its own
  change because the sandbox lacks something, that is the factory's bug, not the
  reviewer's problem. An agent reads the factory's own PRs and fixes the environment.
- **Telemetry exists to earn autonomy.** Every groom, run, environment pass, and PR
  outcome is recorded so that "which classes of task can automerge?" becomes an
  empirical question, not a leap of faith.

## What one tick does

```
reconcile outcomes of previously opened PRs (merged/rejected → telemetry, release issue)
→ GROOM agents (up to groom.maxPerTick, in parallel, newest first): vet issues against
   principles.md — "groomed" or "needs-work", recorded as a label, alongside a comment
   giving the conclusion, why, and any coding-level notes (the issue is never closed)
→ ENVIRONMENT agent: reads the factory PRs it has not read yet, looking for a check the
   implementer could not run, and fixes .cursor/environment.json in the target repo so the
   next one can. Opens a PR only when it finds a gap it can close; one open at a time
count the jobs already in flight (open factory PRs + running pipelines)
   → no free slot under maxConcurrentJobs? stop here
for each free slot:
   → SELECTOR agent: gets the GROOMED issues (minus factory:wip claims, issues
      assigned to a human, and the picks made earlier this tick) and picks the most
      well-scoped one by judgment — no scores, no weights
   label the pick factory:wip
→ handoff to a FRESH implementer agent per pick, running concurrently, each with a
   short workflow prompt and the issue LINK (not its text — the agent reads the
   issue itself, notes and all)
label the resulting PRs `factory`, comment on the issues, record telemetry
stop — a human merging or closing a PR is what frees the next slot
```

Grooming sits ahead of the capacity gate on purpose: it produces no code, so a PR
awaiting review is no reason to stop vetting the backlog. Nothing is implemented until
it has been groomed, which makes the pipeline self-throttling — an empty groomed set
means the factory idles rather than picking something unvetted.

## Grooming

Grooming is the one place the factory is opinionated about **what** to build. It is not
a gate on the agent — it is a gate on the backlog. An autonomous implementer handed a
bad issue produces a confident bad PR, and no amount of agent autonomy fixes an issue
that should not be built. A groomed issue's implementer is in fact *less* boxed in,
because the scoping argument already happened upstream.

Grooming works **newest issue first**. A stale issue's premises are false by
construction — the code moved underneath it — so oldest-first spends the grooming
budget on the part of the backlog least likely to yield anything buildable, while the
factory opens no PRs meanwhile (selection draws only from groomed issues). The first
seven grooms in our first deployment, run against a months-old backlog, were 7/7
`needs-work` — none a false rejection — which is what motivated this ordering.

`principles.md` holds the product-direction principles grooming judges against. They
are deliberately factory-local: they never reach the implementer, which sees only
coding-level direction. That separation is the point — product direction is decided at
grooming time, not at coding time.

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
implemented; the fingerprint only decides what gets looked at again.** So the
selector sees every `factory:groomed` issue, and one that has drifted is both
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
free runs two selector picks and two implementers concurrently — they work on separate
branches, so the only collisions are ones a human resolves at review time. Crashed
pipelines are detected via stale records in the local `telemetry/current-runs.json`
(> `staleRunHours`), recorded as aborted, and cleaned up, so a crash cannot leak a slot.

## The environment

An implementer that cannot verify its own change says so, plainly, in the PR it opens:

> Could not run the job itself here: it pulls the just-built GHCR images, and this
> environment has no Docker.

That is a real finding about the factory, and until it is acted on it is only prose in a
PR body. The environment phase acts on it. An agent is handed the factory PRs it has not
read yet and reads them itself, looking for one thing: **a check the author would have run
and could not, because the machine lacked something.** If the environment can close the
gap, it commits `.cursor/environment.json` (and any Dockerfile it needs) to the target repo
and opens a PR that changes nothing else.

**Nothing is parsed, in either direction.** The implementer is not asked for a structured
report and its reply is not scanned for one — deciding whether a PR describes a blocked
check is a judgment call, so it lives in an agent, handed links the way grooming is handed
an issue link. And the pass's own verdict is the branch it pushed: a PR means it found a
fixable gap, no PR means it did not. That is the same handoff the controller already reads
from an implementer, so the phase adds no new grammar to the factory.

**Not every gap is the environment's to close**, and the prompt is specific about it. A
check that needs an artifact which does not exist yet at review time, or a credential the
factory does not hold, is not an environment problem — the implementer verified the wrong
thing, and the honest answer is a different check. The agent says so and opens no PR. Left
out, this is the phase's obvious failure mode: an agent that installs its way around
problems that were never about the environment.

Either way the finding is posted back onto the PRs that produced it, which is where the
human who hit the blocked check is looking.

**Environment PRs are their own queue, one deep.** They do not count against
`maxConcurrentJobs` and cannot collide with an implementer — one touches only `.cursor/`,
the other only product code — so a full review queue never leaves the agents' machine
broken. The cost is honest: it is a second thing that can be awaiting your review. Set
`environment.enabled` to `false` to turn the phase off entirely.

**A merged environment PR voids every report written before it.** A report is a claim
about the machine the agent ran on, so once that machine changes the claim is about
something that no longer exists — the same move the groom fingerprint makes when a human
replies to an issue. Without this the phase re-fixes what it just fixed: our first
environment PR merged, and the next pass was handed seven reports of "no Docker" all
written on the pre-Docker machine, and dutifully added Docker again. A run that *started*
before the change necessarily ran on the old machine, so `startedAt` is the cutoff.

Voided reports are dropped, not deferred. If the gap one describes still exists, the next
implementer hits it and says so in a PR opened after the change, and that one is read.
Only evidence about the current machine counts.

The phase runs at most once per tick, only when there are unread factory PRs with reports
about the current machine and no environment PR already open, and reads at most
`environment.maxPrsPerPass` of them — newest first, the same ordering grooming uses and
for the same reason. The old tail is starved on a busy factory, deliberately: an unread
old PR costs nothing, a stale environment costs every run.

## Deploying

A deployment is a fork (or "Use this template" copy) of this repo that commits
its own policy on top:

```bash
npm install
cp factory.config.example.json factory.config.json   # point it at your target repo
cp principles.example.md principles.md               # then rewrite it — highest-leverage file here
$EDITOR factory.config.json                          # set groom.principlesFile to principles.md
cp .env.example .env       # put your Cursor API key in it (cursor.com/dashboard → API Keys)
gh auth status             # gh must be authenticated with repo scope on the target repo
```

Commit `factory.config.json` and your `principles.md` to your fork — they *are*
your deployment. Upstream ships only `*.example` versions of both and gitignores
`telemetry/`, so your policy never collides with an engine change:

```bash
git remote add upstream https://github.com/samarmstrong/conveyor.git
git pull upstream main     # engine updates; your policy files are untouched
```

## Commands

```bash
npm run factory -- run             # one tick (the daily entry point)
npm run factory -- run --dry-run   # grooming/backlog state + the exact prompts, launch nothing
npm run factory -- groom           # run just the grooming phase
npm run factory -- select          # run just the selector agent over the groomed issues
npm run factory -- env             # run just the environment phase over the unread factory PRs
npm run factory -- status          # grooming progress, capacity, in-flight jobs, recent telemetry
npm run factory -- abort           # abandon every stuck pipeline (cancels the Cursor runs)
npm run factory -- abort --issue 42  # ...or just the one working issue #42
npm run check                      # typecheck + unit tests
```

## Daily trigger

Two options; both just invoke the idempotent tick.

**Local (launchd, macOS):** copy `contrib/com.example.conveyor.plist` to
`~/Library/LaunchAgents/`, adjust paths, then `launchctl load` it.

**GitHub Actions:** enable `.github/workflows/factory.yml` in your fork (daily
cron + manual dispatch). Requires two repo secrets: `CURSOR_API_KEY`, and
`FACTORY_GH_TOKEN` (a PAT with `repo` scope on the target repo — the default
`GITHUB_TOKEN` is scoped to the fork and cannot touch the target repo). The
tick step is skipped automatically when no `factory.config.json` is committed,
so the workflow is inert in the upstream repo.

## Policy knobs

- `principles.md` — **what is worth building.** The product-direction standard
  grooming enforces. This is the highest-leverage file in the repo; editing it changes
  what the factory will and will not build.
- `factory.config.json` — target repo, model (`null` = Cursor default; list with
  `GET https://api.cursor.com/v1/models`), poll interval, max run minutes,
  `groom.maxPerTick` (how much backlog to vet per tick), `maxConcurrentJobs` (how many
  jobs may be in flight at once — the whole implementation throttle), stale-run cutoff,
  labels.
- `factory.config.json` → `assignedIssues` — whether each phase may act on an issue a
  human has assigned to themselves. Defaults to `{ "groom": true, "implement": false }`:
  vetting an assigned issue costs its assignee nothing, implementing one collides with
  them. Set `implement` to `true` for a repo where assignment means triage rather than
  intent.
- `factory.config.json` → `environment` — `enabled` (default true) and `maxPrsPerPass`
  (default 3): the phase that owns the cloud-agent environment. Off means the factory
  keeps opening PRs whose verification was blocked and never fixes the cause.
- `src/prompts.ts` — all four prompts (groom / selector / implementer / environment), each a few
  lines. Add lines only for specific opinions where the model's default behavior isn't
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

## Telemetry

Append-only JSONL at `telemetry/runs.jsonl`:

- `groom` records: issue, verdict, whether notes were written, whether it was a
  re-groom after the issue changed, agent id, token usage, duration.
- `run` records: issue, worker/model, selector + implementer agent ids, start/end,
  outcome (`pr-opened`/`no-pr`/`failed`/`aborted`), token usage for both agents, duration.
- `env` records: which factory PRs the pass read, whether it opened a PR and which,
  agent id, token usage, duration. A failed pass records no PRs as read, so they are
  offered to the next one.
- `outcome` records: per PR — merged or rejected, human change requests, human
  comment count, time to close, and which pipeline opened it (`implementer` or
  `environment`).

Joining `groom` to `outcome` is the question worth measuring: do issues that carried
grooming notes get merged with fewer human change requests than ones that passed clean?
Joining `env` to the `run` records after it is the second: once an environment PR merges,
do the implementers that follow stop reporting checks they could not run?

This is the dataset for deciding what V2 should be (e.g. automerge for classes of
tasks whose historical human-rejection rate is ~zero).

## Architecture

```
principles.md      what is worth building  ← factory policy (ships as principles.example.md)
src/types.ts       CodingWorker / WorkSource boundaries + telemetry records
src/worker.ts      CursorWorker (Cursor Cloud Agents v1 API) — the only Cursor-aware file
                   Every agent is pinned to one `startingRef`, resolved per tick
src/workSource.ts  GitHubIssueSource (incl. writing groom verdicts back to issues)
src/groom.ts       verdict labels + fingerprint, backlog filters, VERDICT parsing
src/environment.ts unread-PR bookkeeping + report freshness for the environment phase
src/selector.ts    wip + assignee filters, SELECTED-line parsing (mechanical only)
src/prompts.ts     groom + selector + implementer + environment prompts  ← factory policy
src/state.ts       capacity gate (open PRs + in-flight runs), outcome reconciliation
src/controller.ts  the tick
src/github.ts      thin `gh` CLI wrapper
src/telemetry.ts   JSONL groom/run/outcome log
src/cli.ts         run / groom / select / env / status / abort
```

Non-goals (V1, on purpose): custom agent runtime, custom sandboxes, multi-agent
framework, workflow engines, autonomous merging, persistent state machines. Parallelism
is one integer (`maxConcurrentJobs`), not a scheduler. Swapping the worker later = reimplementing `CodingWorker` (three methods
plus usage) — nothing else knows Cursor exists.

## License

[MIT](LICENSE)
