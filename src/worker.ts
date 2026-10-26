// CursorWorker: CodingWorker implemented on the Cursor Cloud Agents v1 API.
// Docs: https://cursor.com/docs/cloud-agent/api/endpoints

import {
  RunBudgetExceeded,
  type CodingWorker, type ModelSpec, type RunHandle, type RunResult, type RunStatus, type StartOptions, type TokenUsage,
} from './types.ts';

const BASE_URL = 'https://api.cursor.com';
const TERMINAL: RunStatus[] = ['FINISHED', 'ERROR', 'CANCELLED', 'EXPIRED'];
/** The backoff Cursor's API docs recommend. */
const RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000];

/**
 * Failures that happen before a connection exists: no name lookup, nothing
 * listening, no route, no handshake in time. A request that fails this way was
 * never sent. A socket closed or a header timed out after the connection is a
 * different case: the request may have arrived and been acted on.
 */
const NEVER_SENT = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT']);

/** `status` is unset when the request never got an answer. */
class CursorApiError extends Error {
  constructor(message: string, readonly status: number | undefined, readonly causeCode?: string) {
    super(message);
  }

  get transient(): boolean {
    return this.status === undefined || this.status === 429 || this.status >= 500;
  }

  /** Cursor cannot have acted on the request: it said so, or never got it. */
  get nothingCreated(): boolean {
    return this.status === 429 || (this.status === undefined && NEVER_SENT.has(this.causeCode ?? ''));
  }
}

/**
 * Cursor reports neither a run's context size nor its compactions, only token
 * totals. Under Anthropic prompt caching every token enters the context once,
 * as uncached input or a cache write, so those two over the run track its peak
 * context: 0.90–0.96 of it across seven Claude Code transcripts that recorded
 * both. Other providers' cache accounting does not hold to that, so no estimate.
 */
export function peakContextEstimate(model: ModelSpec | null, run: TokenUsage): number | undefined {
  if (!model?.id.startsWith('claude-')) return undefined;
  return Math.round((run.inputTokens + run.cacheWriteTokens) / 0.93);
}

export interface CursorWorkerOptions {
  apiKey: string;
  repoUrl: string;
  /**
   * Commit to start every agent from. Without it Cursor resolves the base
   * itself and can serve a cached clone — we saw an agent branch from an
   * hour-old main and re-add files a merged PR had already landed, which then
   * conflicted. Pinning a sha means the base cannot be stale, and every agent
   * in one tick shares it.
   */
  startingRef: string | null;
  model: ModelSpec | null;
  /**
   * Credentials injected into every agent's shell, by variable name. Cursor
   * scopes them to the agent and deletes them with it. The field is in beta on
   * Cursor's side and silently dropped for accounts without it, so an agent
   * reporting the variable missing is a Cursor account question first.
   */
  envVars?: Record<string, string>;
  pollIntervalSeconds: number;
  maxRunMinutes: number;
  log?: (msg: string) => void;
}

interface RunPayload {
  id: string;
  agentId?: string;
  status: RunStatus;
  result?: string;
  durationMs?: number;
  git?: { branches?: { repoUrl?: string; branch?: string; prUrl?: string }[] };
}

export class CursorWorker implements CodingWorker {
  constructor(private readonly opts: CursorWorkerOptions) {}

  /** The commit every agent this worker launches starts from. */
  get startingRef(): string | null {
    return this.opts.startingRef;
  }

  private log(msg: string): void {
    this.opts.log?.(msg);
  }

  /**
   * A GET that fails in transit, is rate-limited, or meets a 5xx is asked
   * again: on 2026-09-30 single dropped polls killed seven runs in four ticks,
   * each already doing or done with its work. A POST is retried only when
   * nothing can have been created: on 429, or when the connection itself never
   * opened. The same day, two launches whose response never came back had each
   * started an agent anyway, so a socket reset or a header timeout on a launch
   * fails it rather than risk two agents on one issue; the issue keeps its
   * place in the queue and is taken again next tick.
   */
  private async api<T>(method: string, path: string, body?: unknown): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.request<T>(method, path, body);
      } catch (err) {
        const delay = RETRY_DELAYS_MS[attempt];
        const retryable = err instanceof CursorApiError && (err.nothingCreated || (method === 'GET' && err.transient));
        if (!retryable || delay === undefined) throw err;
        this.log(`${err.message}; retrying in ${delay / 1000}s`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.opts.apiKey}`,
        'Content-Type': 'application/json',
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }).catch((err: Error) => {
      // Node's fetch says only "fetch failed"; what failed is in the cause.
      const cause = err.cause as { code?: string; message?: string } | undefined;
      const why = cause ? ` (${[cause.code, cause.message].filter(Boolean).join(': ')})` : '';
      throw new CursorApiError(`Cursor API ${method} ${path}: ${err.message}${why}`, undefined, cause?.code);
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new CursorApiError(`Cursor API ${method} ${path} → ${res.status}: ${text.slice(0, 500)}`, res.status);
    }
    return (await res.json()) as T;
  }

  async start(prompt: string, opts: StartOptions = {}): Promise<RunHandle> {
    const body: Record<string, unknown> = {
      prompt: { text: prompt },
      // On an existing PR, Cursor checks out its head and `workOnCurrentBranch`
      // sends the agent's pushes there rather than to a new cursor/ branch.
      repos: [{
        url: this.opts.repoUrl,
        ...(opts.prUrl ? { prUrl: opts.prUrl } : (opts.startingRef ?? this.opts.startingRef) ? { startingRef: opts.startingRef ?? this.opts.startingRef } : {}),
      }],
      autoCreatePR: opts.autoCreatePR ?? false,
      ...(opts.prUrl ? { workOnCurrentBranch: true } : {}),
    };
    if (opts.name) body['name'] = opts.name;
    const envNames = opts.withholdCredentials ? [] : Object.keys(this.opts.envVars ?? {});
    if (envNames.length > 0) body['envVars'] = this.opts.envVars;
    const model = opts.model ?? this.opts.model;
    if (model) {
      const { id, params } = model;
      body['model'] = {
        id,
        ...(params ? { params: Object.entries(params).map(([pid, value]) => ({ id: pid, value })) } : {}),
      };
    }

    const json = await this.api<{ agent: { id: string }; run: { id: string } }>(
      'POST', '/v1/agents', body,
    );
    this.log(`launched agent ${json.agent.id} run ${json.run.id}${envNames.length ? ` (env: ${envNames.join(', ')})` : ''}`);
    return { agentId: json.agent.id, runId: json.run.id };
  }

  async continueRun(handle: RunHandle, instruction: string): Promise<RunHandle> {
    const json = await this.api<{ run?: { id: string }; id?: string }>(
      'POST', `/v1/agents/${handle.agentId}/runs`, { prompt: { text: instruction } },
    );
    const runId = json.run?.id ?? json.id;
    if (!runId) throw new Error('Cursor API: follow-up run response had no run id');
    this.log(`follow-up on agent ${handle.agentId}: run ${runId}`);
    return { agentId: handle.agentId, runId };
  }

  async agentForPr(prUrl: string): Promise<RunHandle | null> {
    const json = await this.api<{ items: { id: string; latestRunId?: string }[] }>(
      'GET', `/v1/agents?prUrl=${encodeURIComponent(prUrl)}&limit=1`,
    );
    const agent = json.items[0];
    return agent?.latestRunId ? { agentId: agent.id, runId: agent.latestRunId } : null;
  }

  async awaitResult(handle: RunHandle): Promise<RunResult> {
    const deadline = Date.now() + this.opts.maxRunMinutes * 60_000;
    const intervalMs = this.opts.pollIntervalSeconds * 1000;

    for (;;) {
      const run = await this.api<RunPayload>(
        'GET', `/v1/agents/${handle.agentId}/runs/${handle.runId}`,
      );
      if (TERMINAL.includes(run.status)) {
        const branchInfo = run.git?.branches?.[0];
        return {
          status: run.status,
          resultText: run.result ?? '',
          branch: branchInfo?.branch,
          prUrl: branchInfo?.prUrl,
          durationMs: run.durationMs,
        };
      }
      if (Date.now() > deadline) {
        await this.cancel(handle);
        throw new RunBudgetExceeded(handle.runId, this.opts.maxRunMinutes);
      }
      this.log(`agent ${handle.agentId} run ${handle.runId}: ${run.status}`);
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }

  async cancel(handle: RunHandle): Promise<void> {
    await this.api('POST', `/v1/agents/${handle.agentId}/runs/${handle.runId}/cancel`).catch((err: Error) => {
      this.log(`could not cancel agent ${handle.agentId} run ${handle.runId}: ${err.message}`);
    });
  }

  /**
   * The API carries no reason for an ERROR, and the cause is usually outside
   * the run: on 2026-09-16 three implementers died in the same minute because
   * the team's included usage hit 100% with on-demand spend off. The agent
   * page is where that shows, so the log points there.
   */
  opaqueRunNote(handle: RunHandle): string {
    return `Cursor gave no reason; see https://cursor.com/agents/${handle.agentId} (an account-wide cause, such as the usage limit, shows there and hits every run at once)`;
  }

  async usage(agentId: string): Promise<TokenUsage | undefined> {
    try {
      const json = await this.api<{ totalUsage: TokenUsage; cost?: { chargedCents?: number }; runs?: { usage: TokenUsage }[] }>(
        'GET', `/v1/agents/${agentId}/usage`,
      );
      const costCents = json.cost?.chargedCents;
      const firstRun = json.runs?.[0]?.usage;
      const peakContextTokens = firstRun ? peakContextEstimate(this.opts.model, firstRun) : undefined;
      return {
        ...json.totalUsage,
        ...(costCents !== undefined ? { costCents } : {}),
        ...(peakContextTokens !== undefined ? { peakContextTokens } : {}),
      };
    } catch {
      return undefined; // usage is telemetry-only; never fail the pipeline on it
    }
  }
}
