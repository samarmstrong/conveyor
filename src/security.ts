// The security phase: the repo's open Dependabot and code scanning alerts,
// fixed a group at a time, straight to a PR.
//
// A repo's security tab can hold hundreds of alerts, and one PR per alert is the
// slow way through them: one dependency's advisories show up once per advisory
// per lockfile, and one rule fires on every call site of the helper it flags. No
// rule groups them well — the right group is "what one change fixes", and only
// reading the code says what that is. So each tick one agent is handed every
// open alert at or above `security.minSeverity` that no factory PR is fixing,
// picks the most severe group one PR can fix, fixes it, and opens the PR.
//
// No issue, no groom. An alert is already a finished report — what is wrong and
// where — and on a public repo an issue or a groom comment describing it would
// publish an unfixed hole. The fix PR is the first public trace, and it arrives
// with the fix. The alerts reach the agent in its prompt, which is private: an
// alert page is behind a permission the agents' GitHub access does not carry,
// so the tick, which can read them, hands over every field it reads in full.
//
// State lives on the PRs. The agent ends its reply with the alerts its PR
// fixes, and the factory comments them onto the PR over one invisible line:
//
//   <!-- factory-security alerts=dependabot#102,code-scanning#45 -->
//
// An alert is offered again only when no PR speaks for it:
// - an open PR is fixing it;
// - a PR closed unmerged was declined — a human judged the fix not worth it,
//   and the alert is theirs from there;
// - a merged PR fixed it, and GitHub closes the alert itself once the default
//   branch no longer has it. One still open a day after the merge was not
//   fixed, and is offered again with that PR named; after a second such PR it
//   is left for a human.
// GitHub's own rescan is the check that a fix worked. The factory touches an
// alert only to dismiss a code scanning finding the agent showed is a false
// positive — reversible, and on the alert with the agent's reason. A
// dependency alert is never dismissed: upgrading or removing it is always open.

export const SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
export type Severity = typeof SEVERITIES[number];

/** GitHub's UI says "moderate" where its API says "medium"; take either. */
export function parseSeverity(value: unknown): Severity {
  const v = typeof value === 'string' ? value.trim().toLowerCase() : value;
  if (v === 'moderate') return 'medium';
  if ((SEVERITIES as readonly unknown[]).includes(v)) return v as Severity;
  throw new Error(`security.minSeverity must be one of ${SEVERITIES.join(', ')}, got ${JSON.stringify(value)}`);
}

interface AlertBase {
  number: number;
  severity: Severity;
  /** The alert's page on GitHub, readable only with security access. */
  url: string;
}

export interface DependabotAlert extends AlertBase {
  kind: 'dependabot';
  ecosystem: string;
  package: string;
  manifest: string;
  /** `runtime` or `development`, when Dependabot can tell. */
  scope: string | null;
  ghsa: string;
  advisory: string;
  vulnerableRange: string;
  patched: string | null;
}

export interface CodeScanningAlert extends AlertBase {
  kind: 'code-scanning';
  tool: string;
  rule: string;
  ruleDescription: string;
  path: string;
  line: number | null;
  message: string;
}

export type SecurityAlert = DependabotAlert | CodeScanningAlert;

/** How an alert is named everywhere: the prompt, the agent's reply, the stamp. */
export function alertKey(a: Pick<SecurityAlert, 'kind' | 'number'>): string {
  return `${a.kind}#${a.number}`;
}

const KEY_RE = /\b(dependabot|code-scanning)#(\d+)\b/g;
export const keysIn = (text: string): string[] => [...text.matchAll(KEY_RE)].map((k) => `${k[1]}#${k[2]}`);

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

/** One alert, in full, as one markdown line. */
export function describeAlert(a: SecurityAlert): string {
  const head = `${alertKey(a)} **${a.severity}**`;
  if (a.kind === 'dependabot') {
    const fixed = a.patched ? `fixed in \`${a.patched}\`` : 'no patched version yet';
    return `${head} — ${a.ecosystem} \`${a.package}\` in \`${a.manifest}\`${a.scope ? ` (${a.scope})` : ''}: ${a.ghsa} (https://github.com/advisories/${a.ghsa}) ${oneLine(a.advisory)}; vulnerable \`${a.vulnerableRange}\`, ${fixed}`;
  }
  return `${head} — ${a.tool} \`${a.rule}\` (${oneLine(a.ruleDescription)}) at \`${a.path}${a.line ? `:${a.line}` : ''}\`: ${oneLine(a.message)}`;
}

/** The slice of a security PR this phase reasons about. */
export interface SecurityPr {
  url: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  mergedAt: string | null;
  comments: { body: string }[];
}

const STAMP_RE = /<!--\s*factory-security\s+alerts=([^\s>]*)\s*-->/g;

export function securityStamp(keys: string[]): string {
  return `<!-- factory-security alerts=${keys.join(',')} -->`;
}

/** The alerts a PR's stamps claim. */
export function claimedBy(pr: Pick<SecurityPr, 'comments'>): string[] {
  return pr.comments.flatMap((c) => [...c.body.matchAll(STAMP_RE)].flatMap((m) => keysIn(m[1]!)));
}

/** How long GitHub is given to rescan after a fix merges before the alert counts as unfixed. */
export const RESCAN_GRACE_HOURS = 24;
/** Merged PRs an alert survives before it is left for a human. */
export const MAX_FIX_ATTEMPTS = 2;
/** Open security PRs past which no new one is started: each waits on a human merge. */
export const MAX_OPEN_PRS = 3;
/** The most alerts one pass is handed; the rest wait for the next. */
export const MAX_ALERTS_PER_PASS = 150;

export interface OfferedAlert {
  alert: SecurityAlert;
  /** Merged PRs that claimed this alert and left it open. */
  priorAttempts: string[];
}

export function atLeast(severity: Severity, min: Severity): boolean {
  return SEVERITIES.indexOf(severity) >= SEVERITIES.indexOf(min);
}

/**
 * The alerts the next pass is handed — at or above `min`, claimed by no PR
 * that still speaks for it — most severe first, then oldest. `held` counts the
 * ones at the threshold that a PR does speak for.
 */
export function securityQueue(
  alerts: SecurityAlert[],
  prs: SecurityPr[],
  min: Severity,
  now: number = Date.now(),
): { offered: OfferedAlert[]; held: number } {
  const claims = new Map<string, SecurityPr[]>();
  for (const pr of prs) {
    for (const key of new Set(claimedBy(pr))) claims.set(key, [...(claims.get(key) ?? []), pr]);
  }
  const offered: OfferedAlert[] = [];
  let held = 0;
  for (const alert of alerts.filter((a) => atLeast(a.severity, min))) {
    const by = claims.get(alertKey(alert)) ?? [];
    const merged = by.filter((p) => p.state === 'MERGED');
    const lastMerge = Math.max(0, ...merged.map((p) => Date.parse(p.mergedAt ?? '') || 0));
    const rescanning = merged.length > 0 && now - lastMerge < RESCAN_GRACE_HOURS * 3_600_000;
    if (by.some((p) => p.state !== 'MERGED') || rescanning || merged.length >= MAX_FIX_ATTEMPTS) {
      held++;
      continue;
    }
    offered.push({ alert, priorAttempts: merged.map((p) => p.url) });
  }
  const rank = (o: OfferedAlert) => -SEVERITIES.indexOf(o.alert.severity);
  offered.sort((a, b) => rank(a) - rank(b) || a.alert.kind.localeCompare(b.alert.kind) || a.alert.number - b.alert.number);
  return { offered: offered.slice(0, MAX_ALERTS_PER_PASS), held };
}

/** An offered alert as the agent sees it: in full, plus any fix it outlived. */
export function offeredLine(o: OfferedAlert): string {
  return `${describeAlert(o.alert)}${o.priorAttempts.length ? ` — still open after ${o.priorAttempts.join(', ')} merged` : ''}`;
}

const FIXED_RE = /^[\s>*-]*alerts:(.*)$/gim;
const DISMISS_RE = /^[\s>*-]*false[ -]positive:\s*(code-scanning#\d+)\s*[—–:-]*\s*(.*)$/gim;

/**
 * The agent's reply: the alerts its PR fixes (its `ALERTS:` lines) and the
 * code scanning findings it showed are false positives (`FALSE POSITIVE:`
 * lines, each with its reason). Only offered alerts count, each once; a
 * dependency alert cannot be dismissed.
 */
export function parseFixReply(text: string, offered: string[]): { fixed: string[]; dismiss: { key: string; reason: string }[] } {
  const allowed = new Set(offered);
  const dismiss: { key: string; reason: string }[] = [];
  for (const m of text.matchAll(DISMISS_RE)) {
    if (allowed.delete(m[1]!)) dismiss.push({ key: m[1]!, reason: m[2]!.trim() });
  }
  const fixed = [...text.matchAll(FIXED_RE)].flatMap((m) => keysIn(m[1]!)).filter((k) => allowed.delete(k));
  return { fixed, dismiss };
}

/** Why the security phase is not running at all, or null if it may. */
export function skipReason(
  enabled: boolean,
  workerKind: string,
  openPrs: { url: string }[] = [],
  queue: { offered: number; held: number } = { offered: 1, held: 0 },
): string | null {
  if (!enabled) return 'security phase is disabled in factory.config.json';
  // Upgrading a dependency installs its new release, which runs code nobody
  // here has read — the dependency batch's rule. Cursor's VM is thrown away.
  if (workerKind !== 'cursor') return `security fixes run only on the cursor worker (worker.kind is ${workerKind}): upgrading a dependency runs its new release's code, and a local agent would run it on this machine`;
  if (openPrs.length >= MAX_OPEN_PRS) return `${openPrs.length} security PRs are awaiting a merge (${openPrs.map((p) => p.url).join(', ')})`;
  if (queue.offered === 0) return queue.held > 0 ? `every open alert at the threshold is claimed by a factory PR (${queue.held})` : 'no open alerts at the threshold';
  return null;
}
