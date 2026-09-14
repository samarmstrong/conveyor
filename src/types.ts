// Core factory abstractions. Deliberately minimal: these exist to keep
// Cursor-specific details out of the factory policy, not to be a framework.

export interface Task {
  id: string; // e.g. "acme/widgets#123"
  issueNumber: number;
  title: string;
  body: string;
  /** In chronological order. Grooming judges the description and these together. */
  comments: IssueComment[];
  labels: string[];
  /** GitHub logins. A non-empty list is a human's claim on the issue. */
  assignees: string[];
  url: string;
}

export interface IssueComment {
  body: string;
}

export interface ModelSpec {
  id: string;
  /** Param values per `GET /v1/models`, e.g. { effort: "high", fast: "false" }. */
  params?: Record<string, string>;
}

export interface RunHandle {
  agentId: string;
  runId: string;
}

export type RunStatus =
  | 'CREATING'
  | 'RUNNING'
  | 'FINISHED'
  | 'ERROR'
  | 'CANCELLED'
  | 'EXPIRED';

export interface RunResult {
  status: RunStatus;
  resultText: string;
  branch: string | undefined;
  prUrl: string | undefined;
  durationMs: number | undefined;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  costCents?: number;
}

/** The coding worker boundary. V1 implementation: Cursor cloud agents. */
export interface CodingWorker {
  /** Launch a fresh agent on the target repo. */
  start(prompt: string, opts?: StartOptions): Promise<RunHandle>;
  /** Send a follow-up instruction to an existing agent (same workspace/branch). */
  continueRun(handle: RunHandle, instruction: string): Promise<RunHandle>;
  /** Poll a run until it reaches a terminal state. */
  awaitResult(handle: RunHandle): Promise<RunResult>;
  /** Token usage across all runs of an agent. */
  usage(agentId: string): Promise<TokenUsage | undefined>;
}

export interface StartOptions {
  autoCreatePR?: boolean;
  name?: string;
}

/**
 * A grooming verdict. Two outcomes, not three: an issue is either worth
 * building (with notes appended when there is something the implementer needs
 * to know) or it is not ready as written.
 */
export type GroomVerdict = 'groomed' | 'needs-work';

/** The work source boundary. V1 implementation: GitHub issues. */
export interface WorkSource {
  eligibleTasks(): Promise<Task[]>;
  markStarted(task: Task): Promise<void>;
  markFinished(task: Task): Promise<void>;
  /** Publish a groom verdict on the issue: a stamped comment saying what the
   *  factory concluded and why, plus a label mirroring it. */
  recordGroom(
    task: Task,
    reply: { verdict: GroomVerdict; notes: string | undefined; reasoning: string; blocked?: number },
    /** What the stamp carries beyond the fingerprint: for a child, the epic
     *  record it was judged against; for an epic, its open children. Both are
     *  what lets the verdict be revisited when the world moves. */
    extras?: { premise?: { epic: number; sha: string } | null; children?: number[] },
  ): Promise<void>;
  /** File the children a groomed epic's groomer wrote, each linked back to the
   *  epic, and note them on the epic. Returns what was filed. */
  fileChildren(epic: Task, children: { title: string; body: string }[]): Promise<{ number: number; url: string }[]>;
  /** An implementation attempt refuted the groomed verdict: flip the label to
   *  needs-work and say why, so the issue is not picked again as scoped. */
  recordFailedAttempt(task: Task, report: string): Promise<void>;
}

// --- Telemetry records (append-only JSONL) ---

/** What every agent the factory launches leaves behind, whatever it was for. */
interface AgentPass {
  worker: string;
  model: ModelSpec | null;
  agentId: string;
  startedAt: string;
  finishedAt: string;
  usage: TokenUsage | null;
  durationMs: number;
}

export interface RunRecord extends AgentPass {
  type: 'run';
  taskId: string;
  issueNumber: number;
  issueTitle: string;
  selectorAgentId?: string;
  outcome: 'pr-opened' | 'no-pr' | 'failed' | 'aborted';
  failureReason?: string;
  prUrl: string | null;
  selectorUsage?: TokenUsage | null;
}

export interface GroomRecord extends AgentPass {
  type: 'groom';
  taskId: string;
  issueNumber: number;
  issueTitle: string;
  verdict: GroomVerdict;
  /** True when the issue had been groomed before and its description changed. */
  regroom: boolean;
  hadNotes: boolean;
  /** The issue was groomed as an epic: a direction, not a PR. */
  epic?: boolean;
  /** Children filed under a groomed epic. */
  childrenFiled?: number;
  /** The issue a needs-work verdict is waiting on. */
  blockedOn?: number;
}

export interface OutcomeRecord {
  type: 'outcome';
  prUrl: string;
  /** Which pipeline opened it. Absent on records written before env passes
   *  existed, which were all implementer PRs. */
  source?: 'implementer' | 'environment' | 'simplify';
  issueNumber: number | null;
  merged: boolean;
  closedAt: string;
  humanChangeRequests: number;
  humanCommentCount: number;
  recordedAt: string;
}

/**
 * One pass of the environment agent: it read some factory PRs and either found
 * a gap the cloud-agent environment could close (and opened a PR closing it) or
 * did not. `prsExamined` is what makes a pass idempotent — those PRs are never
 * read again — so a failed pass records none of them and they are retried.
 */
export interface EnvRecord extends AgentPass {
  type: 'env';
  prsExamined: string[];
  outcome: 'pr-opened' | 'no-gap' | 'failed';
  prUrl: string | null;
  failureReason?: string;
}

/**
 * One pass of the simplification agent. It opened a PR that removes more lines
 * than it adds, or one that did not (`grew` — the factory closed it before a
 * human saw it), or proposed nothing. `baseSha` is the commit it read: a pass
 * that reached a conclusion is not repeated on the same one.
 */
export interface SimplifyRecord extends AgentPass {
  type: 'simplify';
  baseSha: string | null;
  outcome: 'pr-opened' | 'grew' | 'no-change' | 'failed';
  prUrl: string | null;
  /** GitHub's count for the PR, when one was opened. */
  additions?: number;
  deletions?: number;
  failureReason?: string;
}

export type TelemetryRecord = RunRecord | GroomRecord | OutcomeRecord | EnvRecord | SimplifyRecord;

// --- Pipeline state for crash detection ---

export interface CurrentRun {
  taskId: string;
  issueNumber: number;
  agentId: string;
  runId: string;
  startedAt: string;
  prUrl: string | null;
}
