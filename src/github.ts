// Thin wrapper around the `gh` CLI. Uses gh's own auth (or GH_TOKEN when set),
// which keeps token plumbing out of the factory for both local and CI runs.

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import type { ReviewPr } from './review.ts';
import type { DepsPr } from './deps.ts';
import type { AdvisoryReport, CodeScanningAlert, DependabotAlert, Severity } from './security.ts';

const execFileAsync = promisify(execFile);

/** Same as `gh`, but feeds `input` on stdin — for bodies too long for argv. */
async function ghStdin(args: string[], input: string): Promise<string> {
  return new Promise((res, rej) => {
    const child = spawn('gh', args);
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', rej);
    child.on('close', (code) => {
      if (code === 0) res(out);
      else rej(new Error(`gh ${args.slice(0, 3).join(' ')} failed: ${err || `exit ${code}`}`));
    });
    child.stdin.end(input);
  });
}

export async function gh(args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('gh', args, {
      maxBuffer: 32 * 1024 * 1024,
    });
    return stdout;
  } catch (err) {
    const e = err as { stderr?: string; message: string };
    throw new Error(`gh ${args.slice(0, 3).join(' ')} failed: ${e.stderr || e.message}`);
  }
}

export async function ghJson<T>(args: string[]): Promise<T> {
  const out = await gh(args);
  return JSON.parse(out) as T;
}

export interface IssueData {
  number: number;
  title: string;
  body: string;
  url: string;
  labels: { name: string }[];
  comments: { body: string }[];
  assignees: { login: string }[];
}

/**
 * Past any backlog the factory will meet. `gh` pages through the open issues
 * until it has this many, and it lists newest first: a cap the backlog
 * outgrows hides the oldest issues, which are the ones every queue takes first.
 * 156 open issues with bodies and comments come back in about four seconds.
 */
const ALL_OPEN_ISSUES = 10_000;

/** Every open issue, which is the set grooming, picking and blocked verdicts all read. */
export async function listOpenIssues(repo: string): Promise<IssueData[]> {
  return ghJson<IssueData[]>([
    'issue', 'list', '-R', repo, '--state', 'open',
    '--limit', String(ALL_OPEN_ISSUES), '--json', 'number,title,body,url,labels,comments,assignees',
  ]);
}

/**
 * Whether an issue or pull request is still open. `repos/…/issues/N` answers
 * for both, which is the point: a groom verdict may be blocked on a PR, and the
 * issue list never sees one. `unknown` when GitHub could not say — deleted,
 * transferred, or the call failed.
 */
export async function referenceState(repo: string, number: number): Promise<'open' | 'closed' | 'unknown'> {
  try {
    const { state } = await ghJson<{ state: string }>(['api', `repos/${repo}/issues/${number}`]);
    return state === 'open' ? 'open' : state === 'closed' ? 'closed' : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Open issues carrying a label — the in-progress label, for reconciliation. */
export async function listIssuesByLabel(repo: string, label: string, limit = 100): Promise<IssueData[]> {
  return ghJson<IssueData[]>([
    'issue', 'list', '-R', repo, '--state', 'open', '--label', label,
    '--limit', String(limit), '--json', 'number,title,body,url,labels,comments,assignees',
  ]);
}

/** Issues of any state carrying a label, with why the closed ones closed. */
export async function listAllIssuesByLabel(repo: string, label: string, limit = 200): Promise<{ number: number; url: string; state: 'OPEN' | 'CLOSED'; stateReason: string; body: string }[]> {
  return ghJson(['issue', 'list', '-R', repo, '--state', 'all', '--label', label, '--limit', String(limit), '--json', 'number,url,state,stateReason,body']);
}

/** An issue's labels as they stand, and when each was last put on. */
export interface LabelHistory {
  open: boolean;
  labels: string[];
  /** Label name → when it was last applied, from the issue's timeline. */
  labelledAt: Record<string, string>;
}

/**
 * The label history of each issue named, fifty to a GraphQL call. A number
 * GitHub cannot resolve as an issue — a pull request, a deleted issue — is
 * left out, and so is every number in a batch whose call failed outright:
 * what a caller cannot see, it holds rather than acts on.
 */
export async function labelHistory(repo: string, issues: number[]): Promise<Map<number, LabelHistory>> {
  const [owner, name] = repo.split('/');
  const unique = [...new Set(issues)];
  const history = new Map<number, LabelHistory>();
  for (let i = 0; i < unique.length; i += 50) {
    const batch = unique.slice(i, i + 50);
    const fields = batch.map((n) =>
      `i${n}: issue(number: ${n}) { state labels(first: 50) { nodes { name } } timelineItems(itemTypes: [LABELED_EVENT], last: 100) { nodes { ... on LabeledEvent { createdAt label { name } } } } }`);
    const query = `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${fields.join(' ')} } }`;
    // GitHub answers what it can resolve and errors on the rest, and gh then
    // exits non-zero with the partial answer on stdout.
    const stdout = await execFileAsync('gh', ['api', 'graphql', '-f', `owner=${owner}`, '-f', `name=${name}`, '-f', `query=${query}`], { maxBuffer: 32 * 1024 * 1024 })
      .then((r) => r.stdout, (err: { stdout?: string }) => err.stdout ?? '');
    type Node = { state: string; labels: { nodes: { name: string }[] }; timelineItems: { nodes: { createdAt?: string; label?: { name: string } }[] } } | null;
    let found: Record<string, Node> | undefined;
    try {
      found = (JSON.parse(stdout) as { data?: { repository?: Record<string, Node> } }).data?.repository;
    } catch {
      continue;
    }
    for (const n of batch) {
      const issue = found?.[`i${n}`];
      if (!issue) continue;
      const labelledAt: Record<string, string> = {};
      // Oldest first, so the last event for a label is the one that stands.
      for (const e of issue.timelineItems.nodes) if (e.label && e.createdAt) labelledAt[e.label.name] = e.createdAt;
      history.set(n, { open: issue.state === 'OPEN', labels: issue.labels.nodes.map((l) => l.name), labelledAt });
    }
  }
  return history;
}

export interface PrData {
  number: number;
  url: string;
  title: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  isDraft: boolean;
  createdAt: string;
  mergedAt: string | null;
  closedAt: string | null;
  body: string;
  reviews: { state: string }[];
  comments: { author: { login: string }; body: string; url: string }[];
  headRefName: string;
  additions: number;
  deletions: number;
}

const PR_FIELDS = 'number,url,title,state,isDraft,createdAt,mergedAt,closedAt,body,reviews,comments,headRefName,additions,deletions';

export async function listPrsByLabel(repo: string, label: string, state: 'open' | 'closed' | 'merged' | 'all', limit = 50): Promise<PrData[]> {
  return ghJson<PrData[]>([
    'pr', 'list', '-R', repo, '--label', label, '--state', state,
    '--limit', String(limit), '--json', PR_FIELDS,
  ]);
}

/** Every open PR, whoever opened it, with its labels. */
export async function listOpenPrs(repo: string): Promise<(PrData & { labels: { name: string }[] })[]> {
  return ghJson(['pr', 'list', '-R', repo, '--state', 'open', '--limit', '100', '--json', `${PR_FIELDS},labels`]);
}

export async function findPrByBranch(repo: string, branch: string): Promise<PrData | null> {
  const prs = await ghJson<PrData[]>([
    'pr', 'list', '-R', repo, '--head', branch, '--state', 'all',
    '--limit', '1', '--json', PR_FIELDS,
  ]);
  return prs[0] ?? null;
}

/** Open a PR from `branch` onto the default branch; returns its URL. */
export async function createPr(repo: string, branch: string, title: string, body: string): Promise<string> {
  const out = await ghStdin(['pr', 'create', '-R', repo, '--head', branch, '--title', title, '--body-file', '-'], body);
  return out.trim().split('\n').pop()!;
}

export async function viewPr(repo: string, prUrl: string): Promise<PrData> {
  return ghJson<PrData>(['pr', 'view', prUrl, '-R', repo, '--json', PR_FIELDS]);
}

/**
 * The target's default branch and the commit it currently points at. Agents are
 * launched pinned to that sha rather than letting the worker resolve "the
 * default branch" itself — see `CursorWorkerOptions.startingRef`.
 */
export async function defaultBranchHead(repo: string): Promise<{ branch: string; sha: string }> {
  const { default_branch: branch } = await ghJson<{ default_branch: string }>(['api', `repos/${repo}`]);
  const { sha } = await ghJson<{ sha: string }>(['api', `repos/${repo}/commits/${branch}`]);
  return { branch, sha };
}

export async function ensureLabel(repo: string, name: string, color: string, description: string): Promise<void> {
  // `--force` makes creation idempotent (updates if it exists).
  await gh(['label', 'create', name, '-R', repo, '--color', color, '--description', description, '--force']);
}

export async function addIssueLabels(repo: string, issue: number, labels: string[]): Promise<void> {
  await gh(['issue', 'edit', String(issue), '-R', repo, ...labels.flatMap((l) => ['--add-label', l])]);
}

export async function removeIssueLabels(repo: string, issue: number, labels: string[]): Promise<void> {
  await gh(['issue', 'edit', String(issue), '-R', repo, ...labels.flatMap((l) => ['--remove-label', l])]);
}

export async function editIssueBody(repo: string, issue: number, body: string): Promise<void> {
  await ghStdin(['issue', 'edit', String(issue), '-R', repo, '--body-file', '-'], body);
}

export async function addPrLabels(repo: string, prUrl: string, labels: string[]): Promise<void> {
  // REST rather than `gh pr edit`: the latter's GraphQL query touches the
  // deprecated Projects-classic field and fails on repos where that's sunset.
  const prNumber = prUrl.match(/\/pull\/(\d+)/)?.[1];
  if (!prNumber) throw new Error(`cannot parse PR number from ${prUrl}`);
  await gh([
    'api', `repos/${repo}/issues/${prNumber}/labels`,
    ...labels.flatMap((l) => ['-f', `labels[]=${l}`]),
  ]);
}

export async function createIssue(
  repo: string,
  title: string,
  body: string,
  labels: string[],
): Promise<{ number: number; url: string }> {
  const out = await ghStdin(
    ['issue', 'create', '-R', repo, '--title', title, '--body-file', '-', ...labels.flatMap((l) => ['--label', l])],
    body,
  );
  const url = out.trim().split('\n').find((l) => /\/issues\/\d+$/.test(l));
  const number = url?.match(/\/issues\/(\d+)$/)?.[1];
  if (!url || !number) throw new Error(`gh issue create returned no issue URL: ${out.slice(0, 200)}`);
  return { number: Number(number), url };
}

export async function closeIssue(repo: string, issue: number, reason: 'completed' | 'not planned'): Promise<void> {
  await gh(['issue', 'close', String(issue), '-R', repo, '--reason', reason]);
}

export async function commentOnIssue(repo: string, issue: number, body: string): Promise<void> {
  // Via stdin: groom rationales are longer than argv is worth trusting.
  await ghStdin(['issue', 'comment', String(issue), '-R', repo, '--body-file', '-'], body);
}

export async function commentOnPr(repo: string, prUrl: string, body: string): Promise<void> {
  await ghStdin(['pr', 'comment', prUrl, '-R', repo, '--body-file', '-'], body);
}

/**
 * Take a PR out of draft. Cursor opens the implementer's PR itself, and whether
 * it comes out as a draft varies run to run with nothing in the factory's
 * control (four runs in a row stayed drafts; the runs before them did not).
 * A draft waits on nobody, so the factory clears it the moment it labels the PR.
 */
export async function markPrReady(repo: string, prUrl: string): Promise<void> {
  const { isDraft } = await viewPr(repo, prUrl);
  if (isDraft) await gh(['pr', 'ready', prUrl, '-R', repo]);
}

export interface PrCheck {
  name: string;
  /** gh's rollup of a check's state; `cancel` is what gh calls a cancelled run. */
  bucket: 'pass' | 'fail' | 'pending' | 'skipping' | 'cancel';
  link: string;
}

/**
 * The PR's checks as they stand right now. Exit code is 0 even when checks
 * are red because of `--json`; without it gh signals red with a nonzero exit
 * and the wrapper would throw. A PR with no checks at all — a repo without CI,
 * or a fork's first run waiting on a maintainer's approval — makes gh exit
 * nonzero even with `--json`; that is an empty list, not an error.
 */
export async function prChecks(repo: string, prUrl: string): Promise<PrCheck[]> {
  try {
    return await ghJson<PrCheck[]>(['pr', 'checks', prUrl, '-R', repo, '--json', 'name,bucket,link']);
  } catch (err) {
    if (/no checks reported/i.test((err as Error).message)) return [];
    throw err;
  }
}

/**
 * Approve the workflow runs a commit is held on. GitHub holds a fork PR's runs
 * (`action_required`) until a maintainer approves them — a first-time
 * contributor's, by default — and until then the PR has no checks at all.
 * Returns how many runs were approved.
 */
export async function approveHeldRuns(repo: string, sha: string): Promise<number> {
  const ids = await ghJson<number[]>(['api', `repos/${repo}/actions/runs?head_sha=${sha}&status=action_required&per_page=100`, '--jq', '[.workflow_runs[].id]']);
  for (const id of ids) await gh(['api', '-X', 'POST', `repos/${repo}/actions/runs/${id}/approve`]);
  return ids.length;
}

/**
 * Wait for a PR's checks to settle, and return the failing ones. A repo with no
 * checks settles once `graceMs` has passed with none appearing — GitHub
 * registers a fresh push's check runs some seconds after the push, so a PR read
 * the moment it opens shows none even where CI is about to run (one PR was
 * reported "checks none" and its red lint never went back). With
 * `expectChecks`, runs were just approved and an empty list waits until
 * `maxWaitMs`. Gives up after `maxWaitMs` and treats whatever is still pending
 * as not failing: a slow CI is not the implementer's fault, and the human sees
 * the real state on the PR either way.
 */
export async function awaitPrChecks(
  repo: string,
  prUrl: string,
  opts: { maxWaitMs: number; pollMs: number; expectChecks?: boolean; graceMs?: number; log?: (msg: string) => void },
): Promise<{ failed: PrCheck[]; settled: boolean }> {
  const started = Date.now();
  const deadline = started + opts.maxWaitMs;
  for (;;) {
    const checks = await prChecks(repo, prUrl);
    const pending = checks.filter((c) => c.bucket === 'pending');
    const unregistered = checks.length === 0 && (opts.expectChecks === true || Date.now() - started < (opts.graceMs ?? 0));
    const waiting = pending.length > 0 || unregistered;
    if (!waiting) return { failed: checks.filter((c) => c.bucket === 'fail'), settled: true };
    if (Date.now() > deadline) return { failed: checks.filter((c) => c.bucket === 'fail'), settled: false };
    opts.log?.(`${prUrl}: ${pending.length > 0 ? `${pending.length} check(s) still running` : 'waiting for its checks to register'}`);
    await new Promise((r) => setTimeout(r, opts.pollMs));
  }
}

export async function closePr(repo: string, prUrl: string, comment: string): Promise<void> {
  await gh(['pr', 'close', prUrl, '-R', repo, '--comment', comment]);
}

const REVIEW_PR_FIELDS = 'number,url,title,state,isDraft,body,author,headRefOid,isCrossRepository,labels,comments';

/**
 * PRs in one state, whoever opened them: the review phase's candidates. Closed
 * ones are the unmerged, most recently updated first — an author replying to a
 * close updates the PR, however old its number.
 */
export async function listPrsForReview(repo: string, state: 'open' | 'closed', limit: number): Promise<ReviewPr[]> {
  const recent = state === 'closed' ? ['--search', 'is:unmerged sort:updated-desc'] : [];
  return ghJson<ReviewPr[]>(['pr', 'list', '-R', repo, '--state', state, ...recent, '--limit', String(limit), '--json', REVIEW_PR_FIELDS]);
}

export async function viewPrForReview(repo: string, prUrl: string): Promise<ReviewPr & { files: { path: string }[] }> {
  return ghJson(['pr', 'view', prUrl, '-R', repo, '--json', `${REVIEW_PR_FIELDS},files`]);
}

/** Dependabot's open PRs: the dependency phase's candidates. */
export async function listDependabotPrs(repo: string): Promise<DepsPr[]> {
  return ghJson<DepsPr[]>(['pr', 'list', '-R', repo, '--author', 'app/dependabot', '--state', 'open', '--limit', '50',
    '--json', 'number,url,title,isDraft,headRefName,headRefOid,files,comments']);
}

/** Every page of a list endpoint, one `jq`-shaped object per item. */
async function ghApiList<T>(path: string, jq: string): Promise<T[]> {
  const out = await gh(['api', '--paginate', path, '--jq', jq]);
  return out.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as T);
}

/** The repo's open Dependabot alerts. Throws when the token cannot read them or they are off. */
export async function listDependabotAlerts(repo: string): Promise<DependabotAlert[]> {
  return ghApiList(`repos/${repo}/dependabot/alerts?state=open&per_page=100`, `.[] | {
    kind: "dependabot", number, severity: .security_advisory.severity, url: .html_url,
    ecosystem: .dependency.package.ecosystem, package: .dependency.package.name,
    manifest: .dependency.manifest_path, scope: .dependency.scope,
    ghsa: .security_advisory.ghsa_id, advisory: .security_advisory.summary,
    vulnerableRange: .security_vulnerability.vulnerable_version_range,
    patched: .security_vulnerability.first_patched_version.identifier }`);
}

/**
 * The repo's open code scanning alerts that carry a security severity — a
 * quality finding has none. Throws when the token cannot read them or code
 * scanning has never run.
 */
export async function listCodeScanningAlerts(repo: string): Promise<CodeScanningAlert[]> {
  return ghApiList(`repos/${repo}/code-scanning/alerts?state=open&per_page=100`, `.[] | select(.rule.security_severity_level != null) | {
    kind: "code-scanning", number, severity: .rule.security_severity_level, url: .html_url,
    tool: .tool.name, rule: .rule.id, ruleDescription: .rule.description,
    path: .most_recent_instance.location.path, line: .most_recent_instance.location.start_line,
    message: .most_recent_instance.message.text }`);
}

/**
 * The repo's privately reported vulnerabilities not yet closed or published —
 * those in triage, and the drafts, which a maintainer's own report is born as
 * — each with its whole description. Which of them the factory still owes an
 * answer is `openReports`' call. Throws when the token cannot read them.
 */
export async function listAdvisoryReports(repo: string): Promise<AdvisoryReport[]> {
  const list = (state: 'triage' | 'draft') => ghApiList<AdvisoryReport>(`repos/${repo}/security-advisories?state=${state}&per_page=100`, `.[] | {
    kind: "advisory", ghsa: .ghsa_id, state: "${state}", severity, url: .html_url, summary, description: (.description // ""),
    cwes: [.cwes[]? | (.cwe_id + " " + .name)], reporter: .author.login, createdAt: .created_at,
    cvss: .cvss.vector_string, affected: [.vulnerabilities[]? | .vulnerable_version_range // empty] }`);
  const [triage, draft] = await Promise.all([list('triage'), list('draft')]);
  return [...triage, ...draft];
}

/**
 * The repo's draft advisories — reports accepted but not yet closed or
 * published — with their descriptions, where the factory's acceptance note
 * names the fix PR. Throws when the token cannot read them.
 */
export async function listAcceptedReports(repo: string): Promise<{ ghsa: string; summary: string; description: string }[]> {
  return ghApiList(`repos/${repo}/security-advisories?state=draft&per_page=100`, `.[] | { ghsa: .ghsa_id, summary, description: (.description // "") }`);
}

/**
 * Write the factory's assessment onto a reported advisory: the note goes at
 * the end of its description, under a rule, where the reporter and the
 * maintainers read it — the advisory has no comment API — and the severity
 * and state change with it when asked. `draft` accepts a report, `closed`
 * rejects it or finishes it once its fix merged; both are a human's to undo
 * from the advisory's page. The
 * description is re-read first so a line someone added since the tick read
 * it is kept.
 */
export async function annotateAdvisory(repo: string, ghsa: string, note: string, change: { severity?: Severity; state?: 'draft' | 'closed' } = {}): Promise<void> {
  const current = await gh(['api', `repos/${repo}/security-advisories/${ghsa}`, '--jq', '.description // ""']);
  const body: Record<string, string> = { description: `${current.trimEnd()}\n\n---\n\n${note.trim()}\n` };
  if (change.severity) body.severity = change.severity;
  if (change.state) body.state = change.state;
  await ghStdin(['api', '-X', 'PATCH', `repos/${repo}/security-advisories/${ghsa}`, '--input', '-'], JSON.stringify(body));
}

/**
 * Dismiss a code scanning alert as a false positive, with the reason on the
 * alert. Reversible: reopening it in the security tab undoes this.
 */
export async function dismissCodeScanningAlert(repo: string, number: number, comment: string): Promise<void> {
  await gh(['api', '-X', 'PATCH', `repos/${repo}/code-scanning/alerts/${number}`,
    '-f', 'state=dismissed', '-f', 'dismissed_reason=false positive', '-f', `dismissed_comment=${comment.slice(0, 280)}`]);
}

/**
 * Whether a PR merges cleanly into its base. GitHub works this out lazily: after
 * a merge to the base it answers `UNKNOWN` until asked, then computes it in a
 * few seconds. That is exactly when a conflict appears — the babysitter merges
 * and then starts the tick — so ask again for up to ~30s before settling for it.
 */
export async function prMergeable(
  repo: string,
  prUrl: string,
  opts: { attempts?: number; delayMs?: number } = {},
): Promise<{ mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN'; baseRefName: string }> {
  const { attempts = 10, delayMs = 3_000 } = opts;
  for (let i = 1; ; i++) {
    const pr = await ghJson<{ mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN'; baseRefName: string }>(
      ['pr', 'view', prUrl, '-R', repo, '--json', 'mergeable,baseRefName']);
    if (pr.mergeable !== 'UNKNOWN' || i >= attempts) return pr;
    await new Promise((r) => setTimeout(r, delayMs));
  }
}

/** Close without a comment of gh's own: the factory's stamped comment is posted first. */
export async function closePrQuietly(repo: string, prUrl: string): Promise<void> {
  await gh(['pr', 'close', prUrl, '-R', repo]);
}

export async function reopenPr(repo: string, prUrl: string): Promise<void> {
  await gh(['pr', 'reopen', prUrl, '-R', repo]);
}

/**
 * Squash-merge exactly `sha`: GitHub refuses if the head has moved since. Never
 * `--admin` — the factory's token can bypass the repo's rules, and a merge that
 * needed to is one the repo's rules said no to.
 */
export async function mergePr(repo: string, prUrl: string, sha: string, body?: string): Promise<void> {
  // Reviews merge in parallel, and two landing in the same second race: GitHub
  // refuses the loser with "Base branch was modified" (#1415 lost to #1418).
  // Nothing about the PR is wrong, so the merge is simply tried again.
  for (let attempt = 1; ; attempt++) {
    try {
      await gh(['pr', 'merge', prUrl, '-R', repo, '--squash', '--match-head-commit', sha, ...(body !== undefined ? ['--body', body] : [])]);
      return;
    } catch (err) {
      if (attempt >= 4 || !/base branch was modified/i.test((err as Error).message)) throw err;
      await new Promise((r) => setTimeout(r, attempt * 5_000));
    }
  }
}

/** A GitHub user's numeric id: what a noreply co-author address is built on. */
export async function userId(login: string): Promise<number> {
  return (await ghJson<{ id: number }>(['api', `users/${login}`])).id;
}

/**
 * A user's role on the repo — `admin`, `maintain`, `write`, `triage`, `read` —
 * or `none` for someone who is not a collaborator (GitHub answers 404). The
 * `.github/` rule reads this: it is about who could already run workflows with
 * the repo's secrets.
 */
export async function collaboratorPermission(repo: string, login: string): Promise<string> {
  try {
    return (await ghJson<{ role_name: string }>(['api', `repos/${repo}/collaborators/${login}/permission`])).role_name;
  } catch (err) {
    if (/404|Not Found/i.test((err as Error).message)) return 'none';
    throw err;
  }
}

/** Extract "Closes #N" / "#N" issue references from a PR body. */
export function linkedIssueNumber(prBody: string): number | null {
  const m = prBody.match(/(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/i) ?? prBody.match(/#(\d+)/);
  return m ? Number(m[1]) : null;
}
