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
- **State lives in the issues, not in a database.** Groom verdicts are stamped
  into the issue body with a content fingerprint; edit the issue and it gets
  re-reviewed. There is no state to migrate, back up, or drift.
- **One PR in flight; a human merge is the throttle.** The factory stops while
  a PR awaits review. Autonomy is widened by editing policy, not by adding
  machinery.
- **Short prompts; the model's judgment is trusted.** No forced output schemas
  beyond two one-line handoffs, no controller-orchestrated review gates, no
  evidence protocols. Prompt lines exist only where we are specifically
  opinionated.
- **Telemetry exists to earn autonomy.** Every groom, run, and PR outcome is
  recorded so that "which classes of task can automerge?" becomes an empirical
  question, not a leap of faith.

## What one tick does

```
reconcile outcomes of previously opened PRs (merged/rejected → telemetry, release issue)
→ GROOM agents (up to groom.maxPerTick, in parallel, newest first): vet issues against
   principles.md — either "groomed" (with coding-level notes appended to the issue)
   or "needs-work" (label + a comment saying why; the issue is never closed)
if a factory PR is open (awaiting a human) → stop here
if a pipeline is already in flight        → stop here
→ SELECTOR agent: gets the GROOMED issues (minus factory:wip claims) and picks the
   most well-scoped one by judgment — no scores, no weights
label the pick factory:wip
→ handoff to a FRESH implementer agent with a short workflow prompt and the issue
   LINK (not its text — the agent reads the issue itself, notes and all)
label the resulting PR `factory`, comment on the issue, record telemetry
stop — a human must merge or close the PR before the factory takes another task
```

Grooming sits ahead of the active-job gate on purpose: it produces no code, so a PR
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

**State lives in the issue, not in a local file.** A groomed issue carries one
HTML-comment block at the end of its body (invisible when rendered):

```
<!-- factory-groom:start sha=a1b2c3d4e5f6 verdict=groomed -->
## Factory grooming notes
Stay inside services/worker; reuse Settings rather than adding a second validator.
<!-- factory-groom:end -->
```

`sha` fingerprints the human-authored part of the body. So no block means never
groomed, and a fingerprint mismatch means someone edited the description since — the
verdict is void and the issue is groomed again on the next tick. That is the whole
answer to "what if the description changes later": **edit the issue and it gets
re-reviewed**, whether it previously passed or was rejected. It costs no extra API
calls, since issue bodies are already fetched.

The `factory:groomed` / `factory:needs-work` labels mirror this for humans browsing the
issue list, but the code always re-derives state from the body — a hand-edited label
cannot make the factory act wrongly.

The tick is idempotent: run it as often as you like; it never starts a second job while
one is awaiting human action. A crashed pipeline is detected via a stale local
`telemetry/current-run.json` (> `staleRunHours`), recorded as aborted, and cleaned up.

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
npm run factory -- status          # grooming progress, active job, pending PRs, recent telemetry
npm run factory -- abort           # abandon a stuck pipeline (cancels the Cursor run)
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
  `groom.maxPerTick` (how much backlog to vet per tick), stale-run cutoff, labels.
- `src/prompts.ts` — all three prompts (groom / selector / implementer), each a few
  lines. Add lines only for specific opinions where the model's default behavior isn't
  what you want. **Widening autonomy later = widening this policy, not adding
  machinery.**
- `src/selector.ts` — only the mechanical bits: filter `factory:wip` claims and
  parse the selector's `SELECTED: #N` handoff line.
- `src/groom.ts` — only the mechanical bits: the body stamp, its fingerprint, the
  backlog filters, and `VERDICT`-line parsing.

## Telemetry

Append-only JSONL at `telemetry/runs.jsonl`:

- `groom` records: issue, verdict, whether notes were written, whether it was a
  re-groom after an edit, agent id, token usage, duration.
- `run` records: issue, worker/model, selector + implementer agent ids, start/end,
  outcome (`pr-opened`/`no-pr`/`failed`/`aborted`), token usage for both agents, duration.
- `outcome` records: per PR — merged or rejected, human change requests, human
  comment count, time to close.

Joining `groom` to `outcome` is the question worth measuring: do issues that carried
grooming notes get merged with fewer human change requests than ones that passed clean?

This is the dataset for deciding what V2 should be (e.g. automerge for classes of
tasks whose historical human-rejection rate is ~zero).

## Architecture

```
principles.md      what is worth building  ← factory policy (ships as principles.example.md)
src/types.ts       CodingWorker / WorkSource boundaries + telemetry records
src/worker.ts      CursorWorker (Cursor Cloud Agents v1 API) — the only Cursor-aware file
src/workSource.ts  GitHubIssueSource (incl. writing groom verdicts back to issues)
src/groom.ts       body stamp + fingerprint, backlog filters, VERDICT parsing
src/selector.ts    wip filter + SELECTED-line parsing (mechanical only)
src/prompts.ts     groom + selector + implementer prompts  ← factory policy
src/state.ts       single-active-job invariant, outcome reconciliation
src/controller.ts  the tick
src/github.ts      thin `gh` CLI wrapper
src/telemetry.ts   JSONL groom/run/outcome log
src/cli.ts         run / groom / select / status / abort
```

Non-goals (V1, on purpose): custom agent runtime, custom sandboxes, multi-agent
framework, workflow engines, autonomous merging, parallel tasks, persistent state
machines. Swapping the worker later = reimplementing `CodingWorker` (three methods
plus usage) — nothing else knows Cursor exists.

## License

[MIT](LICENSE)
