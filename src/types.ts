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
  recordGroom(task: Task, reply: { verdict: GroomVerdict; notes: string | undefined; reasoning: string }): Promise<void>;
}

// --- Telemetry records (append-only JSONL) ---

export interface RunRecord {
  type: 'run';
  taskId: string;
  issueNumber: number;
  issueTitle: string;
  worker: string;
  model: ModelSpec | null;
  agentId: string;
  selectorAgentId?: string;
  startedAt: string;
  finishedAt: string;
  outcome: 'pr-opened' | 'no-pr' | 'failed' | 'aborted';
  failureReason?: string;
  prUrl: string | null;
  usage: TokenUsage | null;
  selectorUsage?: TokenUsage | null;
  durationMs: number;
}

export interface GroomRecord {
  type: 'groom';
  taskId: string;
  issueNumber: number;
  issueTitle: string;
  verdict: GroomVerdict;
  /** True when the issue had been groomed before and its description changed. */
  regroom: boolean;
  hadNotes: boolean;
  worker: string;
  model: ModelSpec | null;
  agentId: string;
  startedAt: string;
  finishedAt: string;
  usage: TokenUsage | null;
  durationMs: number;
}

export interface OutcomeRecord {
  type: 'outcome';
  prUrl: string;
  /** Which pipeline opened it. Absent on records written before env passes
   *  existed, which were all implementer PRs. */
  source?: 'implementer' | 'environment';
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
export interface EnvRecord {
  type: 'env';
  prsExamined: string[];
  outcome: 'pr-opened' | 'no-gap' | 'failed';
  prUrl: string | null;
  failureReason?: string;
  worker: string;
  model: ModelSpec | null;
  agentId: string;
  startedAt: string;
  finishedAt: string;
  usage: TokenUsage | null;
  durationMs: number;
}

export type TelemetryRecord = RunRecord | GroomRecord | OutcomeRecord | EnvRecord;

// --- Pipeline state for crash detection ---

export interface CurrentRun {
  taskId: string;
  issueNumber: number;
  agentId: string;
  runId: string;
  startedAt: string;
  prUrl: string | null;
}
