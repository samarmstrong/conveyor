// Thin wrapper around the `gh` CLI. Uses gh's own auth (or GH_TOKEN when set),
// which keeps token plumbing out of the factory for both local and CI runs.

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

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

export async function listPrsByLabel(repo: string, label: string, state: 'open' | 'closed' | 'merged' | 'all'): Promise<PrData[]> {
  return ghJson<PrData[]>([
    'pr', 'list', '-R', repo, '--label', label, '--state', state,
    '--limit', '50', '--json', PR_FIELDS,
  ]);
}

export async function findPrByBranch(repo: string, branch: string): Promise<PrData | null> {
  const prs = await ghJson<PrData[]>([
    'pr', 'list', '-R', repo, '--head', branch, '--state', 'all',
    '--limit', '1', '--json', PR_FIELDS,
  ]);
  return prs[0] ?? null;
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

export async function commentOnIssue(repo: string, issue: number, body: string): Promise<void> {
  // Via stdin: groom rationales are longer than argv is worth trusting.
  await ghStdin(['issue', 'comment', String(issue), '-R', repo, '--body-file', '-'], body);
}

export async function commentOnPr(repo: string, prUrl: string, body: string): Promise<void> {
  await ghStdin(['pr', 'comment', prUrl, '-R', repo, '--body-file', '-'], body);
}

export async function closePr(repo: string, prUrl: string, comment: string): Promise<void> {
  await gh(['pr', 'close', prUrl, '-R', repo, '--comment', comment]);
}

/** Extract "Closes #N" / "#N" issue references from a PR body. */
export function linkedIssueNumber(prBody: string): number | null {
  const m = prBody.match(/(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/i) ?? prBody.match(/#(\d+)/);
  return m ? Number(m[1]) : null;
}
