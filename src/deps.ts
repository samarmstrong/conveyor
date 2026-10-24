// The dependency phase: Dependabot's PRs, landed as one.
//
// Dependabot opens a handful of version bumps a week, and a human merging them
// one by one reads nothing: they are merged on a green check. That check is
// often not about the bump at all. A repo that installs from a lockfile tests
// the lockfile, and Dependabot's pip updates move the ranges in
// requirements.txt without touching the lock — CI passes on the versions the
// repo already had, and the new ones are first installed whenever someone next
// regenerates the lock by hand. So the phase does not merge Dependabot's PRs.
// One agent carries all of them onto one branch, regenerates whatever the repo
// actually installs from, and opens one PR; CI then runs once, on the versions
// that ship, and the factory merges it on green under the review phase's rules.
// The Dependabot PRs it carried are closed with a link.
//
// No verification beyond CI, deliberately: the batch exists so that a week of
// bumps costs one CI run and one agent, not one of each per bump. A bump that
// breaks CI and has no small fix is dropped from the batch, and the agent says
// why in the PR. A dropped bump is not a human's problem: what the agent wrote
// is an issue-sized description of the work the upgrade needs, so the factory
// files it as one — groomed and implemented like any issue — and closes the
// Dependabot PR in its favour. #1220 (SQLAlchemy 2.1, which needs a database
// driver change) sat open for a week as "left for a human" before this. The
// issue carries one invisible line naming the package:
//
//   <!-- factory-deps-upgrade package=sqlalchemy -->
//
// so Dependabot's next bump of the same package, dropped for the same reason,
// joins the open issue instead of filing another, and one whose issue was
// closed as not planned is closed as declined.
//
// State lives on the Dependabot PRs, the way the review phase's does. Every PR
// a batch reached a conclusion on — carried it, or dropped it — gets a factory
// comment over one invisible line:
//
//   <!-- factory-deps head=a1b2c3d4e5f6 -->
//
// and is not offered again until its head moves: Dependabot rebasing it, or
// bumping it to a newer version. A batch that never reached a conclusion (the
// agent errored) stamps nothing and is retried next tick. One batch PR is open
// at a time; while one is, the phase waits for it.

import { touchesGithub } from './review.ts';

/** The slice of a Dependabot PR this phase reasons about. */
export interface DepsPr {
  number: number;
  url: string;
  title: string;
  isDraft: boolean;
  headRefName: string;
  headRefOid: string;
  files: { path: string }[];
  comments: { body: string }[];
}

const STAMP_RE = /<!--\s*factory-deps\s+head=([0-9a-f]+)\s*-->/g;

export function depsStamp(pr: Pick<DepsPr, 'headRefOid'>): string {
  return `<!-- factory-deps head=${pr.headRefOid.slice(0, 12)} -->`;
}

/** Whether a batch already reached a conclusion on this PR as it stands. */
export function concluded(pr: Pick<DepsPr, 'headRefOid' | 'comments'>): boolean {
  return pr.comments.some((c) => [...c.body.matchAll(STAMP_RE)].some((m) => pr.headRefOid.startsWith(m[1]!)));
}

/**
 * The Dependabot PRs the next batch is offered, oldest first. Not drafts, not
 * one a batch already concluded on at this head, and not one that changes
 * `.github/` — a GitHub Actions bump — because the factory merges those only
 * from an author with write access, which a bot is not, so carrying one would
 * only hold the rest of the batch back.
 */
export function depsQueue(prs: DepsPr[]): DepsPr[] {
  return prs
    .filter((p) => !p.isDraft && !concluded(p) && touchesGithub(p.files).length === 0)
    .sort((a, b) => a.number - b.number);
}

/**
 * The offered PRs the batch says it carries: the ones its description names on
 * a `Supersedes #N` line. Read from the PR as it stands, not from the agent's
 * reply, so a bump dropped in the CI fix round is dropped here too.
 */
export function carried(body: string, offered: number[]): number[] {
  const named = new Set<number>();
  for (const line of body.matchAll(/^[\s>*-]*supersedes\b(.*)$/gim)) {
    for (const ref of line[1]!.matchAll(/#(\d+)/g)) named.add(Number(ref[1]));
  }
  return offered.filter((n) => named.has(n));
}

/**
 * The bumps the batch dropped, with the agent's reason: its `Dropped #N: why`
 * lines. Read from the PR as it stands, like `carried`.
 */
export function droppedReasons(body: string, offered: number[]): Map<number, string> {
  const reasons = new Map<number, string>();
  for (const m of body.matchAll(/^[\s>*-]*dropped\s+#(\d+)\s*[:—–-]\s*(.+)$/gim)) {
    const n = Number(m[1]);
    if (offered.includes(n) && !reasons.has(n)) reasons.set(n, m[2]!.trim());
  }
  return reasons;
}

/** What a Dependabot title says it moves: `bump X from A to B`, `update X requirement from A to B`, `… in /dir`. */
export function bumpOf(title: string): { pkg: string; to: string | null; dir: string | null } | null {
  const m = title.match(/\b(?:bump|update)\s+(\S+)\s+(?:requirement\s+)?from\s+\S+\s+to\s+(\S+)(?:\s+in\s+(\S+))?/i);
  return m ? { pkg: m[1]!, to: m[2]!, dir: m[3] && m[3] !== '/' ? m[3] : null } : null;
}

/** The key an upgrade issue is found by: the package, and the directory when Dependabot names one. */
export function upgradeKey(pr: Pick<DepsPr, 'number' | 'title'>): string {
  const b = bumpOf(pr.title);
  return b ? `${b.pkg}${b.dir ? `@${b.dir}` : ''}` : `pr-${pr.number}`;
}

const UPGRADE_RE = /<!--\s*factory-deps-upgrade\s+package=(\S+)\s*-->/;

export function upgradeStamp(key: string): string {
  return `<!-- factory-deps-upgrade package=${key} -->`;
}

/** The package an upgrade issue is for, or null if it is not one. */
export function upgradeKeyOf(body: string): string | null {
  return body.match(UPGRADE_RE)?.[1] ?? null;
}

/** The issue a dropped bump becomes: what Dependabot proposed, why it is more than a bump, and what done is. */
export function upgradeIssue(pr: Pick<DepsPr, 'number' | 'url' | 'title'>, reason: string, batchUrl: string | null): { title: string; body: string } {
  const b = bumpOf(pr.title);
  const what = b ? `\`${b.pkg}\`${b.dir ? ` in \`${b.dir}\`` : ''}` : 'this dependency';
  const title = b ? `Upgrade ${b.pkg}${b.dir ? ` in ${b.dir}` : ''}${b.to ? ` to ${b.to}` : ''}` : `Land ${pr.title}`;
  return {
    title,
    body: `${upgradeStamp(upgradeKey(pr))}
Dependabot proposed ${pr.url} ("${pr.title}"). The factory's dependency batch${batchUrl ? `, ${batchUrl},` : ''} tried it and left it out, because taking it needs more than a version bump:

> ${reason.replace(/\n/g, '\n> ')}

**Done** is ${what} on the version Dependabot proposed${b?.to ? ` (\`${b.to}\`)` : ''}: the declared range and whatever the repo actually installs from (its lockfile, regenerated the way the repo does), with the code changes the upgrade needs, and CI green on it. ${pr.url} was closed in favour of this issue, and Dependabot does not reopen it.`,
  };
}

/** Why the dependency phase is not running at all, or null if it may. */
export function skipReason(enabled: boolean, workerKind: string, openBatches: { url: string }[] = []): string | null {
  if (!enabled) return 'dependency phase is disabled in factory.config.json';
  // New releases of third-party packages are code nobody here wrote, and
  // resolving and building them runs it. Cursor's VM is thrown away.
  if (workerKind !== 'cursor') return `dependency batches run only on the cursor worker (worker.kind is ${workerKind}): installing new package versions runs their code, and a local agent would run it on this machine`;
  if (openBatches.length > 0) return `a dependency batch is still open (${openBatches.map((p) => p.url).join(', ')})`;
  return null;
}
