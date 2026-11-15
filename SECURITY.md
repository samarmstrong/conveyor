# Security policy

## Reporting a vulnerability

Please report it privately, not in a public issue or pull request. Use
[**Report a vulnerability**](https://github.com/samarmstrong/conveyor/security/advisories/new)
on this repository's Security tab. That opens a private advisory only the maintainers
can read.

Include what you found, how to reproduce it, and what an attacker gains. A
proof of concept helps; a working exploit against someone else's deployment does not
belong in a report.

We will acknowledge a report within 5 business days and tell you what we decided. We
credit reporters in the advisory unless asked not to.

## What counts

This repository is the engine that drives coding agents against a GitHub
repository. In scope:

- a way for text a stranger controls (an issue, a PR, a comment, a branch name, a
  repository file) to make the factory merge, close, label, or push something it
  should not, or leak a credential it holds;
- credentials reaching an agent, a log, the `telemetry` branch, or a comment that the
  [threat model](docs/threat-model.md) says they should not reach;
- a workflow or script here that runs attacker-influenced input as code.

Out of scope:

- anything that needs write access to this repository or the target repository to
  begin with (that access already lets a person run a workflow with the secrets);
- a prompt injection that only changes what an agent *writes*, with no effect past the
  PR or comment a person then reads (the [threat model](docs/threat-model.md) lists
  these as accepted);
- vulnerabilities in the target repository a deployment points the factory at: report
  those in that repository's own security policy;
- vulnerabilities in Cursor, Claude Code, GitHub, or another service the factory
  calls: report those to their vendors.

## Supported versions

Only the `main` branch. There are no releases; run a current checkout.

## If you run your own copy

Treat `FACTORY_GH_TOKEN`, `CURSOR_API_KEY`, and `CLAUDE_CODE_OAUTH_TOKEN` as the keys
to the target repository, scope them as narrowly as the
[threat model](docs/threat-model.md) suggests, and rotate them if a tick log or the
`telemetry` branch might have exposed one.
