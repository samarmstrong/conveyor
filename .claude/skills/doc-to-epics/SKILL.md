---
name: doc-to-epics
description: Turn a product or design document into factory inputs on the target repo — replies on the epics it revises and new epics for the directions it adds — written so the groomer and implementer need nothing but the issue. Use when someone shares a design doc, product recommendation, roadmap, or plan revision and asks to feed it to the factory, file epics for it, or groom it from a product perspective.
---

# doc-to-epics

The factory consumes **direction**, not documents. A direction is a capability that
should become true and why. An epic is one direction, filed as an issue with the repo's
epic label; the groomer (see `README.md`, *Epics: where direction comes from*) settles its
decisions against the code and writes the children. A revision of a document is a **reply
on the epics it changes**, never a new epic and never a re-filed one.

The document itself never reaches the factory. Documents are usually internal, mix
direction with plans and business context, and live behind logins the cloud agents do not
have. So this skill runs locally, with whatever access you have, and its output is
**standalone**: the epic or reply carries, in its own words, everything a groomer and an
implementer would have gone to the document for. The document is consulted once, here.

**Documents are often transcripts.** A product doc today is usually the residue of the
author's conversation with a model: the requirements are the author's, but the tables that
assign work to people or to the factory, the day plans, the "what not to do" lists, and
the paragraphs that say which module or engine or pattern to use are frequently the
model's, and the author has not decided any of it. Treat the document's structure as
incidental. Extract what the author wants to become true; leave how, who and when to the
groomer, the code and the schedule they already have.

It drafts first and posts only on confirmation; posting is outward-facing.

## Inputs

- The document: a local path, a Drive or Notion page you can read from here, or a URL.
- `factory.config.json` in this repo: `repo`, `labels.epic`, `labels.groomed`,
  `labels.needsWork`, `groom.principlesFile`. Everything below is relative to that repo.

## Steps

1. **Load the standard.** Read the principles file and the README's epic section. The
   groomer judges epics against these; the drafts should already speak their language:
   what becomes possible, decisions with defaults and reversal costs, where it pulls
   against which principle, what only a human may decide.

2. **Inventory the epics that exist.**
   ```
   gh issue list -R <owner/name> --label <labels.epic> --state open --json number,title,url,body,labels
   gh api repos/<owner/name>/issues/<n>/comments --jq '.[] | select(.body | test("<!-- factory-groom")) | .body'
   gh issue list -R <owner/name> --state open --search "Part of #<n>" --json number,title,labels
   ```
   For each epic keep its record — the latest `🏭 Factory groom` comment, whose numbered
   decisions are what a reply may name — and its open children with their verdicts.

3. **Extract the requirements first, to `<doc-name>-directions.md`, and show it.** This
   is a pre-step with its own artifact, so what was stripped is visible before anything
   is drafted. Read the document once and write, per direction, only:
   - what should become true that is not true now, in behavioural terms an operator
     would recognise;
   - why the author wants it: the premise about the product, the user, or the market;
   - the acceptance the author has in mind, if the document states one;
   - the open questions the author raises, and the author's stated preference on each
     **only where the document gives a reason for it**. A preference with no reason is
     not a requirement and is dropped.

   Strip, and list under *Set aside* with one line each on why:
   - schedules, day plans, release windows and version numbers;
   - **any allocation of work to people, teams, or the factory**. A document's
     "Factory takes / humans keep" table, an "owner" column, an "owner-in-the-loop"
     clause, a "the factory should not build this unsupervised" sentence: none of it is
     a requirement, none of it enters an epic, and none of it withholds a direction from
     being filed. Whether a human must decide something is the groomer's call, under the
     three reasons the principles give (irreversible, legal or licensing exposure, widens
     what the system may do unattended), and the human veto is a reply on the epic;
   - implementation mechanism: which module, file, framework, engine, playbook-versus-
     agent shape, run kind, table, or pattern to use. The groomer settles shape against
     the code as it stands. An author's mechanism preference survives only as a
     *decision to settle* with the author's reason attached, never as a requirement;
   - competitive reviews, pricing, org design, and anything for a repo the factory does
     not target;
   - "what not to do" lists that are about process rather than product behaviour.

   A document may yield several directions or none. Collect separately, without pursuing
   them, things the document gets wrong about the code or the factory that you can verify
   in one look; the user decides whether to send those back to the author.

4. **Map each direction.**
   - Same capability or seam as an existing epic → a **reply** on that epic.
   - Otherwise → a **new epic**.
   - A child-sized change to an existing epic is still a reply: the groomer writes
     children, the human does not.
   - A direction the document marks as human work is mapped like any other. If it is
     truly human-only, the groomer will say so with the reason named, and that reason
     goes in the record where the team can see it.

5. **Draft to a file** next to the document (`<doc-name>-factory-inputs.md`) and show it.

   Everything below is written **standalone**. The test: a groomer with the issue, the
   code, and nothing else can settle the decisions; an implementer with the child, the
   record, and the code can build. No link to the document, no "see section X", no
   "per the plan". One line of provenance is enough: the document's title, revision,
   author and date, and that this text carries what bears on this issue. Code paths,
   issue numbers and PRs in the target repo are the only references.

   *Reply on an epic* — written **in the author's name or quoting the author**, addressed
   to the groomer:
   - what the revision changes relative to the record, one numbered item each, each
     stating the change **in full** — what the capability is, what behaviour is expected,
     why the author wants it — and naming the decision in the record it touches, or
     saying it touches none and where it fits;
   - for each, whether the author **asks to reverse** that decision. Take this from the
     author's words. If the document does not say, **ask the author before posting**; do
     not infer "this is not an ask to reverse" on their behalf. Unnamed decisions stand;
     that is the ratchet the groomer applies on a re-review;
   - one line asking the groomer to re-review with this in view.

   *New epic* — title starting `Epic:`; labels: the epic label plus the repo's own area
   labels that fit; body in the repo's issue style, in five parts:
   - **What becomes possible** that is not possible now, and why the author wants it:
     the reasoning, the premises about the product and the code, the acceptance the
     author has in mind. Name the code the document names only where it names a seam
     the capability must meet, not where it prescribes an implementation.
   - **Behaviour the author expects**, observable from outside: what an operator sees,
     what is recorded, what is refused, what degrades and how. Enough that the groomer
     can disagree with specifics. Not mechanism.
   - **Decisions to settle**, each with the author's proposed default **where the
     document gives a reason for it**, and the reason. Where the author has no stated
     preference, pose the question and leave the default to the groomer.
   - **Where it pulls against the principles**, by principle, so the groomer settles it
     in the open rather than discovering it.
   - **Human-only decisions**: irreversible, legal or licensing, or widening what the
     system may do unattended. Name them from the principles' three reasons, not from
     the document's allocation of work. Expect these back as needs-work naming them
     unless the epic answers them.
   Do not write children. Do not paste the document verbatim; write the direction as the
   issue's own text. Long is fine; incomplete is not.

6. **Confirm, then post.** Show the drafts and wait for a yes. Then:
   ```
   gh issue comment <n> -R <owner/name> --body-file <reply.md>
   gh issue create -R <owner/name> --title "Epic: …" --label <labels.epic> --label <area> --body-file <epic.md>
   ```
   A reply makes the epic's verdict stale and it is groomed again on the next tick; its
   children follow. A new epic is groomed on the next tick ahead of everything else.
   `npm run factory -- groom` runs it now instead of waiting for the schedule.

7. **Report** the URLs posted, what was set aside and why, what the document got wrong,
   and where the directions and drafts files are.

## Rules

- One epic per direction. A plan is not an epic; "convert this document into 45 issues"
  is the failure mode this skill exists to prevent.
- A revision is a reply. Never file a second epic for a direction that has one, and never
  edit an epic's description to match a revision; the record and its children hang off
  the reply thread.
- Never file children. The groomer files them against the code as it stands.
- Never link or paste the document. The issue is the record; the document was the input.
- Never carry a document's allocation of work into an issue, and never let it decide
  which directions get filed. Every direction is filed; the groomer names what needs a
  human, with the reason.
- Never decide for the author whether a revision reverses a settled decision. Quote them
  or ask them.
- Post nothing without confirmation.
