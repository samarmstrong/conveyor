// The security phase: the repo's open Dependabot and code scanning alerts and
// its privately reported advisories, fixed a group at a time, straight to a PR.
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
//
// A privately reported advisory is the open-ended case. A person (often with a
// model's help) wrote it, and it is a claim, not a finding: the flow it
// describes may not exist, may not be reachable, or may be real at a severity
// other than the one reported, which errs high. So every report in triage is
// offered whatever its severity, and the agent's first job on one is to
// reproduce or trace it against the code. It then answers for each report it
// reached: a fix (the PR claims `advisory#GHSA-…` like any alert, and the
// factory accepts the report as a draft naming the PR), a `FALSE POSITIVE:`
// (the factory closes the report with the reason), or a `SEVERITY:` the agent
// rates itself when the reported one is wrong (the factory sets it). Each is
// written onto the advisory, where the reporter and the maintainers read it,
// and each is reversible from the advisory's page. GitHub closes no report on
// a merge — it does not know a fix landed — so acceptance is the hold: a
// report leaves the queue when it leaves triage, and the factory closes it
// itself on the first pass after its fix merges. The maintainers use these
// reports to track and close security issues, not to publish advisories, so a
// fixed one is done; publishing stays a human's to do from the closed report.
//
// A maintainer's own report skips triage: filed with write access it is born
// a draft, the same state the factory's acceptance puts a report in. So a
// draft is offered too, but only one the factory has never written on — an
// accepted or closed-then-reopened report carries the factory's note and is
// a human's. A report's own request for coordinated disclosure or a private
// fix is not the maintainers' wish — a reporter's tooling is cautious by
// default, and this software runs nowhere public — so it is answered with a
// public PR like any other.

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

/** A privately reported vulnerability nobody has answered: a person's claim, in full. */
export interface AdvisoryReport {
  kind: 'advisory';
  ghsa: string;
  /** `triage` is a report awaiting an answer; `draft` is one a maintainer filed themselves, or one already accepted. */
  state: 'triage' | 'draft';
  /** As reported; null when the reporter rated nothing. Treated as medium for ordering. */
  severity: Severity | null;
  url: string;
  summary: string;
  description: string;
  /** `CWE-400 Uncontrolled Resource Consumption`, as the reporter tagged it. */
  cwes: string[];
  reporter: string | null;
  createdAt: string;
  cvss: string | null;
  /** The reporter's affected-version lines, when given. */
  affected: string[];
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

export type SecurityAlert = DependabotAlert | CodeScanningAlert | AdvisoryReport;

/** The severity an alert is ranked by: as given, or medium for an unrated report. */
export function rankedSeverity(a: Pick<SecurityAlert, 'severity'>): Severity {
  return a.severity ?? 'medium';
}

/**
 * How an alert is named everywhere: the prompt, the agent's reply, the stamp.
 * A report is `advisory#GHSA-…`, prefixed because a Dependabot alert also
 * carries a GHSA id — its dependency's — and a bare one could mean either.
 */
export function alertKey(a: Pick<DependabotAlert | CodeScanningAlert, 'kind' | 'number'> | Pick<AdvisoryReport, 'kind' | 'ghsa'>): string {
  return a.kind === 'advisory' ? `advisory#${a.ghsa}` : `${a.kind}#${a.number}`;
}

const KEY_RE = /\b(?:(dependabot|code-scanning)#(\d+)|(advisory)#(GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}))\b/gi;
export const keysIn = (text: string): string[] => [...text.matchAll(KEY_RE)]
  .map((k) => k[1] ? `${k[1].toLowerCase()}#${k[2]}` : `advisory#GHSA-${k[4]!.slice(5).toLowerCase()}`);

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

/** One alert, in full, as one markdown line. A report is a block; see `describeAdvisory`. */
export function describeAlert(a: DependabotAlert | CodeScanningAlert): string {
  const head = `${alertKey(a)} **${a.severity}**`;
  if (a.kind === 'dependabot') {
    const fixed = a.patched ? `fixed in \`${a.patched}\`` : 'no patched version yet';
    return `${head} — ${a.ecosystem} \`${a.package}\` in \`${a.manifest}\`${a.scope ? ` (${a.scope})` : ''}: ${a.ghsa} (https://github.com/advisories/${a.ghsa}) ${oneLine(a.advisory)}; vulnerable \`${a.vulnerableRange}\`, ${fixed}`;
  }
  return `${head} — ${a.tool} \`${a.rule}\` (${oneLine(a.ruleDescription)}) at \`${a.path}${a.line ? `:${a.line}` : ''}\`: ${oneLine(a.message)}`;
}

/**
 * One report, in full, as a markdown section: the facts on one line, then the
 * reporter's description quoted — every line of it, since a report's whole
 * case is in its text, and quoted because it is the thing being judged.
 */
export function describeAdvisory(a: AdvisoryReport, priorAttempts: string[] = []): string {
  const facts = [
    `reported **${a.severity ?? 'unrated'}**${a.cvss ? ` (${a.cvss})` : ''}`,
    a.reporter ? `by @${a.reporter}` : null,
    `on ${a.createdAt.slice(0, 10)}`,
    a.cwes.length ? `as ${a.cwes.join(', ')}` : null,
    a.affected.length ? `affecting ${a.affected.map(oneLine).join('; ')}` : null,
    a.state === 'draft' ? '— filed as a draft by a maintainer, so it never passed through triage' : null,
  ].filter(Boolean).join(' ');
  const outlived = priorAttempts.length ? `\n\nStill in triage after ${priorAttempts.join(', ')} merged.` : '';
  const quoted = a.description.trim().split('\n').map((l) => `> ${l}`).join('\n');
  return `### ${alertKey(a)} — ${oneLine(a.summary)}\n\n${facts}.${outlived}\n\n${quoted}`;
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
 * Within a severity: findings before reports, since a report is a claim at
 * that severity and a finding is at it; then oldest first — by number for
 * alerts, by filing date for reports.
 */
const KIND_ORDER = ['code-scanning', 'dependabot', 'advisory'] as const;
function order(a: SecurityAlert): string {
  const kind = `${KIND_ORDER.indexOf(a.kind)} ${a.kind}`;
  return a.kind === 'advisory' ? `${kind} ${a.createdAt} ${a.ghsa}` : `${kind} ${String(a.number).padStart(9, '0')}`;
}

/**
 * The alerts the next pass is handed — at or above `min`, claimed by no PR
 * that still speaks for it — most severe first, then oldest. `held` counts the
 * ones at the threshold that a PR does speak for.
 *
 * A report is offered at any severity: the reported one is the reporter's
 * guess, and answering a person's report is not optional. Any PR that claims
 * one holds it for good — GitHub closes no report on a merge, so one still in
 * triage after its fix merged is a human's to accept or close, not a second
 * fixer's.
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
  for (const alert of alerts.filter((a) => a.kind === 'advisory' || atLeast(a.severity, min))) {
    const by = claims.get(alertKey(alert)) ?? [];
    const merged = by.filter((p) => p.state === 'MERGED');
    const lastMerge = Math.max(0, ...merged.map((p) => Date.parse(p.mergedAt ?? '') || 0));
    const rescanning = merged.length > 0 && now - lastMerge < RESCAN_GRACE_HOURS * 3_600_000;
    const spokenFor = alert.kind === 'advisory' ? by.length > 0 : by.some((p) => p.state !== 'MERGED') || rescanning || merged.length >= MAX_FIX_ATTEMPTS;
    if (spokenFor) {
      held++;
      continue;
    }
    offered.push({ alert, priorAttempts: merged.map((p) => p.url) });
  }
  const rank = (o: OfferedAlert) => -SEVERITIES.indexOf(rankedSeverity(o.alert));
  offered.sort((a, b) => rank(a) - rank(b) || order(a.alert).localeCompare(order(b.alert)));
  return { offered: offered.slice(0, MAX_ALERTS_PER_PASS), held };
}

/** An offered alert as the agent sees it: in full, plus any fix it outlived. */
export function offeredLine(o: OfferedAlert): string {
  if (o.alert.kind === 'advisory') return describeAdvisory(o.alert, o.priorAttempts);
  return `${describeAlert(o.alert)}${o.priorAttempts.length ? ` — still open after ${o.priorAttempts.join(', ')} merged` : ''}`;
}

const FIXED_RE = /^[\s>*-]*alerts:(.*)$/gim;
/**
 * A report the factory accepted — its note names the fix PR — and nobody has
 * answered since: the factory's own acceptance is the last word on it. The
 * note is the last factory line in the description, so a report a human
 * reopened after the factory closed it is not here, and neither is one a
 * maintainer wrote as a draft themselves.
 */
export function acceptedFix(description: string): string | null {
  const notes = [...description.matchAll(/\*\*(?:Fix in (https?:\/\/\S+?)\.|Closed by the software factory[^*]*)\*\*/g)];
  const last = notes.at(-1);
  return last?.[1] ?? null;
}

const FACTORY_NOTE_RE = /🏭 \*\*(?:Factory assessment|Closed by the software factory)\*\*/;

/**
 * The reports the factory still owes an answer. A triage report is offered
 * until it leaves triage, re-rated or not. A draft is offered only while the
 * factory has never written on it: one a maintainer filed themselves is a
 * report like any other, but one the factory accepted, or closed and a human
 * reopened, is theirs now.
 */
export function openReports<R extends { state: 'triage' | 'draft'; description: string }>(reports: R[]): R[] {
  return reports.filter((r) => r.state === 'triage' || !FACTORY_NOTE_RE.test(r.description));
}

/**
 * The accepted reports whose fix has merged, each with its PR: these the
 * factory closes, since a fixed report is a done one here. A PR that is not
 * the factory's security PR — a human linked their own — is taken at its word.
 */
export function fixedReports<R extends { ghsa: string; description: string }>(accepted: R[], prs: { url: string; state: string }[]): { report: R; prUrl: string }[] {
  const merged = new Set(prs.filter((p) => p.state === 'MERGED').map((p) => p.url));
  const out: { report: R; prUrl: string }[] = [];
  for (const report of accepted) {
    const prUrl = acceptedFix(report.description);
    if (prUrl && merged.has(prUrl)) out.push({ report, prUrl });
  }
  return out;
}

const DISMISS_RE = /^[\s>*-]*false[ -]positive:\s*((?:code-scanning#\d+)|(?:advisory#GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}))\s*[—–:-]*\s*(.*)$/gim;
const SEVERITY_RE = /^[\s>*-]*severity:\s*(advisory#GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4})\s+(low|medium|moderate|high|critical)\b\s*[—–:-]*\s*(.*)$/gim;

export interface FixReply {
  /** The offered alerts the PR fixes. */
  fixed: string[];
  /** Code scanning findings to dismiss and reports to close, each with the agent's reason. */
  dismiss: { key: string; reason: string }[];
  /** Reports whose severity the agent rated differently from the reporter. */
  rerate: { key: string; severity: Severity; reason: string }[];
}

/**
 * The agent's reply: the alerts its PR fixes (its `ALERTS:` lines), the code
 * scanning findings and reports it showed are false positives (`FALSE
 * POSITIVE:` lines, each with its reason), and the reports it rates at
 * another severity (`SEVERITY:` lines). Only offered alerts count, each once
 * as fixed or dismissed; a dependency alert cannot be dismissed. A re-rating
 * stands on its own: a report may be re-rated and fixed, re-rated and left for
 * the next pass, or re-rated and closed.
 */
export function parseFixReply(text: string, offered: string[]): FixReply {
  const allowed = new Set(offered.map((k) => keysIn(k)[0] ?? k));
  const normalize = (key: string) => keysIn(key)[0] ?? key;
  const dismiss: FixReply['dismiss'] = [];
  for (const m of text.matchAll(DISMISS_RE)) {
    const key = normalize(m[1]!);
    if (allowed.delete(key)) dismiss.push({ key, reason: m[2]!.trim() });
  }
  const fixed = [...text.matchAll(FIXED_RE)].flatMap((m) => keysIn(m[1]!)).filter((k) => allowed.delete(k));
  const rerated = new Set<string>();
  const rerate: FixReply['rerate'] = [];
  for (const m of text.matchAll(SEVERITY_RE)) {
    const key = normalize(m[1]!);
    if (!offered.includes(key) || rerated.has(key)) continue;
    rerated.add(key);
    rerate.push({ key, severity: parseSeverity(m[2]), reason: m[3]!.trim() });
  }
  return { fixed, dismiss, rerate };
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
  if (queue.offered === 0) return queue.held > 0 ? `every open alert at the threshold and every report in triage is claimed by a factory PR (${queue.held})` : 'no open alerts at the threshold and no reports in triage';
  return null;
}
