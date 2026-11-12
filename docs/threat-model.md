# Threat model

What Conveyor trusts, what it hands to agents, and what it does not defend
against. Read it before pointing a factory at a repository that takes issues or pull
requests from people you do not know. To report a vulnerability, see
[SECURITY.md](../SECURITY.md).

The short version: **the factory runs coding agents with write access to a repository,
and those agents read text written by strangers.** The controls below limit what a
hostile issue or PR can reach. They do not make an agent immune to being talked into
something, and the design assumes it can be.

## What is being protected

| Asset | Where it lives | What it gives |
| --- | --- | --- |
| `FACTORY_GH_TOKEN` (or the `gh` login) | Actions secret; the tick's environment | Push branches, open, label, close and merge PRs, and comment on the target repo; read its alerts and, with the right scope, its private advisories |
| `CURSOR_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN` | Actions secrets; `.env` | Spend on the Cursor account or Claude subscription |
| `worker.agentEnv` credentials | Same | Spend, and whatever the named service allows |
| The target repository | GitHub | Its default branch, releases, and every secret its own workflows can read |
| The machine running a tick | The `claude-code` worker, and the Actions runner | Whatever that machine can reach |
| The `telemetry` branch | This repo | Spend, run history, and the GitHub logins of contributors |

## Who the factory trusts

- **Maintainers with write access** to this repo and the target repo. They can already
  run a workflow with the repo's secrets, so nothing here defends against them.
- **The model providers and agent runtimes** (Cursor, Anthropic, OpenRouter). They see
  every prompt and every file an agent reads.
- **`principles.md` and `factory.config.json`**, which are policy and are read as
  instructions. Whoever can change them controls the factory.

Everyone else is untrusted, whatever they claim in an issue or comment: issue authors,
PR authors, commenters, fork owners, and the reporters of security advisories.

## Untrusted input, and where it goes

| Input | Read by | Can run code? |
| --- | --- | --- |
| Issue titles, bodies and comments | The groomer, then the implementer of a groomed issue | Indirectly: the implementer builds what the issue says |
| A PR's description, comments, diff and branch | The review agent | Yes: it builds and runs the PR to verify it |
| Dependabot and code-scanning alerts | The deps and security agents | No, but the alert text is a model input |
| Privately reported advisories | The security agent | No; the prompt treats a report as a claim to check |
| Files in the target repo, including `.mcp.json` | Every agent | `.mcp.json` declares MCP servers the `claude-code` worker will start |

Any issue filed on the target repo is groomed. There is no filter on who filed it.
Grooming is an agent's judgment against `principles.md`, so a persuasive issue can
pass it.

## Controls

These are in the code, not just the docs.

**Credentials are withheld from agents that run strangers' code.** The review, deps,
security and hand-back agents are started with `withholdCredentials`
(`src/controller.ts`), so they get none of `worker.agentEnv`. Implementers do get
them, because they run the live test that needs the real service. An implementer
builds from a groomed issue, not from a stranger's code.

**Untrusted phases get a machine of their own.** Reviews, deps and security work on
code nobody here wrote. On the Cursor worker that is the agent's VM, discarded after
each run. On the `claude-code` worker it is a Docker container per run
(`worker.containers`; `src/claudeCodeWorker.ts`, `src/localMachine.ts`), with the
checkout and the credentials the phase is allowed and nothing else of the host. With
containers off, those phases report themselves skipped rather than run on the tick's
machine. Implementers still run on the host, which is why item 1 below holds.

**Merges are narrow.** The controller merges only the commit the review agent named,
and only while it is still the PR's head (`--match-head-commit`); only with CI green;
never with `--admin`, so the repo's own rules hold; and a change under `.github/` only
when its author has write access to the repo (`src/review.ts`, `mayMergeGithub`).
Workflows run with the repo's secrets, so a fork contributor's workflow change is left
for a person.

**Agents are told that PR text is not an instruction.** The review prompt says so.
This is a mitigation, not a boundary.

**Claude Code agents see only the target repo's MCP servers**
(`--strict-mcp-config`), never the connectors of the machine's owner.

**Spend is bounded.** `maxConcurrentJobs`, `maxRunMinutes`, and `review.maxPerTick`
cap how much work is in flight and for how long.

**State is on GitHub.** The factory keeps no database; its decisions are labels and
signed comments anyone can read and audit.

## What is not defended

Be clear-eyed about these when deciding whether to run a factory on a given repo.

1. **Implementers run with `--dangerously-skip-permissions`** under the `claude-code`
   worker, on a machine you own, and hold `FACTORY_GH_TOKEN` and the `agentEnv`
   credentials in their environment. A hostile issue that gets groomed in can try to
   make the implementer read and send them. Run the `claude-code` worker only on a
   machine you would let an agent run on, with nothing else of value on it.
2. **Prompt injection is not solved.** Grooming, review and the implementer are model
   judgments over attacker-written text. The controls above limit what a successful
   injection can reach; they do not prevent one. Treat a factory PR as code from an
   untrusted author until CI and a person say otherwise.
3. **`FACTORY_GH_TOKEN` is broad.** A PAT with `repo` scope reaches every repository
   its owner can. Prefer a fine-grained token limited to the target repo with the
   contents, pull requests, issues, and (if used) security-events and advisories
   permissions, and nothing else. In Actions the tick step also holds every other
   secret in its environment.
4. **The factory can merge without a person.** The review phase merges outside PRs on
   its own verdict, and a babysitter, where a deployment runs one, merges the
   factory's own PRs unattended. CI is then the only gate on those. Branch protection
   with required checks and, if you want a human in the loop, a required review is the
   control for this; the factory respects it and never bypasses it.
5. **Cost is a target.** Anyone who can file an issue can spend your agent budget.
   `maxConcurrentJobs` and the account's own usage limits are the backstop.
6. **The `telemetry` branch is readable by whoever can read this repo.** It holds
   spend, token counts, agent IDs and contributor logins. If this repo is public, so is
   that. It must never contain a credential: agent error text is written into it, so
   do not put secrets in places an agent prints.
7. **Logs may hold what agents print.** Tick logs under `telemetry/` are local, but an
   agent that echoes a secret writes it there. GitHub Actions masks registered secrets
   in logs; it does not mask a transformed value.

## Running it more safely

- Use a fine-grained token scoped to the target repo, and rotate it on a schedule.
- Give each credential its own account and spending cap, so a leak costs a bounded
  amount.
- Prefer the Cursor worker for anything that touches outside PRs; keep `claude-code`
  for a repository whose issues only your team files.
- Turn on branch protection on the target repo's default branch: required status
  checks, and a required review if you do not want unattended merges.
- Set the Actions default workflow permissions to read-only on this repo. The tick
  asks for what it needs (`contents: write` to append to `telemetry`) in the workflow.
- Keep `.mcp.json` and `.github/` in the target repo under review by a person.

## Reviewing this document

This is a statement of what the code does today. If a control above stops being true,
or an agent gains a capability not listed here, change this file in the same PR.
