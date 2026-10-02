// Thin wrapper around the `gh` CLI. Uses gh's own auth (or GH_TOKEN when set),
// which keeps token plumbing out of the factory for both local and CI runs.

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import type { ReviewPr } from './review.ts';
import type { DepsPr } from './deps.ts';
import type { CodeScanningAlert, DependabotAlert } from './security.ts';

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

export async function listOpenIssues(repo: string, limit: number): Promise<IssueData[]> {
  return ghJson<IssueData[]>([
    'issue', 'list', '-R', repo, '--state', 'open',
    '--limit', String(limit), '--json', 'number,title,body,url,labels,comments,assignees',
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
 * checks settles at once — unless `expectChecks`, when runs were just approved
 * and their checks have yet to appear. Gives up after `maxWaitMs` and treats
 * whatever is still pending as not failing: a slow CI is not the implementer's
 * fault, and the human sees the real state on the PR either way.
 */
export async function awaitPrChecks(
  repo: string,
  prUrl: string,
  opts: { maxWaitMs: number; pollMs: number; expectChecks?: boolean; log?: (msg: string) => void },
): Promise<{ failed: PrCheck[]; settled: boolean }> {
  const deadline = Date.now() + opts.maxWaitMs;
  for (;;) {
    const checks = await prChecks(repo, prUrl);
    const pending = checks.filter((c) => c.bucket === 'pending');
    const waiting = pending.length > 0 || (opts.expectChecks === true && checks.length === 0);
    if (!waiting) return { failed: checks.filter((c) => c.bucket === 'fail'), settled: true };
    if (Date.now() > deadline) return { failed: checks.filter((c) => c.bucket === 'fail'), settled: false };
    opts.log?.(`${prUrl}: ${pending.length > 0 ? `${pending.length} check(s) still running` : 'waiting for the approved runs\' checks'}`);
    await new Promise((r) => setTimeout(r, opts.pollMs));
  }
}

export async function closePr(repo: string, prUrl: string, comment: string): Promise<void> {
  await gh(['pr', 'close', prUrl, '-R', repo, '--comment', comment]);
}

const REVIEW_PR_FIELDS = 'number,url,title,state,isDraft,body,author,headRefOid,isCrossRepository,labels,comments';

/** PRs in one state, whoever opened them: the review phase's candidates. */
export async function listPrsForReview(repo: string, state: 'open' | 'closed', limit: number): Promise<ReviewPr[]> {
  return ghJson<ReviewPr[]>(['pr', 'list', '-R', repo, '--state', state, '--limit', String(limit), '--json', REVIEW_PR_FIELDS]);
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

/**
 * How far a PR is from its base: GitHub's mergeability and how many base
 * commits its head lacks. The compare API resolves a fork's head by sha,
 * since the base repo holds every PR's commits under its pull refs.
 */
export async function prDrift(repo: string, prUrl: string): Promise<{ mergeable: string; behindBy: number }> {
  const pr = await ghJson<{ mergeable: string; baseRefName: string; headRefOid: string }>(
    ['pr', 'view', prUrl, '-R', repo, '--json', 'mergeable,baseRefName,headRefOid']);
  const behind = await gh(['api', `repos/${repo}/compare/${pr.baseRefName}...${pr.headRefOid}`, '--jq', '.behind_by']);
  return { mergeable: pr.mergeable, behindBy: Number(behind.trim()) };
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
  await gh(['pr', 'merge', prUrl, '-R', repo, '--squash', '--match-head-commit', sha, ...(body !== undefined ? ['--body', body] : [])]);
}

/** A GitHub user's numeric id: what a noreply co-author address is built on. */
export async function userId(login: string): Promise<number> {
  return (await ghJson<{ id: number }>(['api', `users/${login}`])).id;
}

/** Extract "Closes #N" / "#N" issue references from a PR body. */
export function linkedIssueNumber(prBody: string): number | null {
  const m = prBody.match(/(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/i) ?? prBody.match(/#(\d+)/);
  return m ? Number(m[1]) : null;
}
