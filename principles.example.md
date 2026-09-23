# Product-direction principles

The standard the target codebase is held to. Grooming applies these to an issue
before any agent implements it. This file is the highest-leverage policy surface
in the factory: it ships as a starting point, and a deployment should rewrite it
to say what is true of — and wanted for — its own codebase. They are about **what to build** — not how to
write the code, and not what the implementer needs to know. Coding-level
direction reaches the implementer through the grooming notes on the issue; these
principles do not.

## What the product is

Replace this section with the handful of commitments that are actually settled
for the target product. Direction is judged against it before anything else in
this file: an epic that breaks one of these is needs-work however well it
argues. Five to eight bullets; a product document does not belong here, and
neither does anything the repository already records. The kind of thing that
does:

- **What it is, and what it is not.** One sentence on the job the product does,
  and the adjacent things it must not turn into on the way.
- **What it may never depend on.** A vendor, a hosted service, a single model
  provider — whatever the product has promised its users it will not require.
- **Where the humans stay.** The one kind of decision the factory may never
  settle on its own, so the groomer knows what to hand back.

## Bloat is the default failure mode

The most likely thing to go wrong is not a bug. It is another feature nobody
needed, wired into everything, that now has to be maintained forever. Agents
produce plausible code cheaply, and the accumulated cost of that is a codebase
whose surface area no longer matches its value.

- An issue that adds a capability must say what becomes possible that was not
  possible before. "Consistency", "completeness", and "future flexibility" are
  not answers.
- Deleting code, collapsing two mechanisms into one, or removing a layer is
  worth more than an equivalent amount of new code.
- If a change needs a new module, a new config surface, and a new abstraction to
  connect them, it is almost certainly too large or the wrong shape.

## Every abstraction must fight for its life

Sprawl is the standing defect of agent-maintained codebases, not a hypothetical
one: the same concept gets modeled several times, in different layers, in
different stacks, and each layer exists mostly to hand work to the next. Every new interface, base
class, wrapper, adapter, registry, manager, factory, or config layer adds to
that, and the burden is on the issue to justify it.

- An indirection with one caller is not an abstraction, it is a detour. Inline
  it. Two real call sites that exist today can justify one; an anticipated
  second caller cannot.
- Generalize only over cases that are actually in front of you. Parameterizing
  for a future shape is how a layer that nobody needed gets in.
- If an issue introduces a concept, name the single place it lives. The same
  concept modeled in two layers is a defect, and an issue that adds the second
  model must say how the first one dies.
- Prefer a longer concrete function to a short one plus three types plus a
  dispatch table. Layers are not free structure; they are the thing that has to
  be read and kept in sync.
- Removing a layer, collapsing two objects into one, or deleting a type is
  first-class work here, not cleanup to do later.

## Trust the agent; do not build the workflow

State-of-the-art agents do not need to be told how to work. Prescription is the
main way this codebase gets worse.

- Do not build orchestration that boxes an agent into fixed steps, forced output
  schemas, or handoffs between roles when one capable agent with the right tools
  would do the same job.
- Do not hand-roll agent loops, retry ladders, planner/executor splits, or
  scratchpad protocols. That is not valuable software; it is scaffolding around a
  capability the model already has.
- Prefer giving an agent a tool and a clear goal over giving it a procedure.

## Do not reinvent what exists

- Before an issue proposes new machinery, it must say what was considered and
  why it does not fit — a library, a platform primitive, or code already in this
  repo.
- Two mechanisms doing the same thing is a defect, not a migration path. An
  issue adding a second one must say how the first one dies.

## Open standards over bespoke glue

Reach for the shared standard before the custom integration.

- A new capability should usually arrive through the platform's existing
  extension points — not a hardcoded call site plus a chain of bespoke glue
  holding it together.
- A custom protocol between our own components needs a reason that an existing
  standard could not satisfy.

## Gates cost more than they protect

- A check that cannot fail in practice, or whose failure everyone routes around,
  is theater. It carries real maintenance cost and buys nothing.
- Approval steps, flags that are never flipped, and defensive layers that
  re-validate what the caller already validated are all in this category.
- Real guardrails — resource ceilings, blast-radius limits, an audit trail — are
  worth their cost. Ceremony is not.
- Autonomy is the direction of travel: the platform should be able to act on its
  own. Prefer making an action safe and observable to putting a human in front of
  it.

## Applying this to an issue

First ask whether there is a correct change here that one PR can land. It may be
narrower than what the issue asks for; if so, that narrowed change is the thing
to build, and the rest is named and left out.

An issue is not ready when there is no such change — when it pulls against the
above, when its premise is already false in the code, or when it is too large
with no smaller correct piece inside it.

Vagueness is not one of those reasons. The implementer is a capable agent: it
chooses names, payloads, signatures, and structure, and does not need the issue
to have decided them. Ask whether the *product* decision has been made — what
should become true, and whether it is worth doing — not whether the issue is
precise. Missing detail is a reason to reject only when filling it in would mean
deciding something that binds work beyond this PR — a schema others must join
to, a contract another component is already written against — and the issue
gives no basis for that decision.

Cite the code. A rejection that cannot point at a file is a guess. And do not
invent a small task to rescue a bad issue: if the narrowed change is not worth
doing on its own, it is busywork, and busywork is the failure mode at the top of
this document.
