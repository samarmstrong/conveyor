// CursorWorker: CodingWorker implemented on the Cursor Cloud Agents v1 API.
// Docs: https://cursor.com/docs/cloud-agent/api/endpoints

import type {
  CodingWorker, ModelSpec, RunHandle, RunResult, RunStatus, StartOptions, TokenUsage,
} from './types.ts';

const BASE_URL = 'https://api.cursor.com';
const TERMINAL: RunStatus[] = ['FINISHED', 'ERROR', 'CANCELLED', 'EXPIRED'];

/**
 * The factory's own `maxRunMinutes` ran out. Distinct from Cursor's terminal
 * statuses because it means something different: an ERROR is the machinery, a
 * blown budget is evidence about the size of the work.
 */
export class RunBudgetExceeded extends Error {
  constructor(readonly runId: string, readonly maxRunMinutes: number) {
    super(`Run ${runId} exceeded ${maxRunMinutes} minutes; cancelled.`);
    this.name = 'RunBudgetExceeded';
  }
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

  private async api<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.opts.apiKey}`,
        'Content-Type': 'application/json',
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Cursor API ${method} ${path} → ${res.status}: ${text.slice(0, 500)}`);
    }
    return (await res.json()) as T;
  }

  async start(prompt: string, opts: StartOptions = {}): Promise<RunHandle> {
    const body: Record<string, unknown> = {
      prompt: { text: prompt },
      repos: [{
        url: this.opts.repoUrl,
        ...(this.opts.startingRef ? { startingRef: this.opts.startingRef } : {}),
      }],
      autoCreatePR: opts.autoCreatePR ?? false,
    };
    if (opts.name) body['name'] = opts.name;
    if (this.opts.model) {
      const { id, params } = this.opts.model;
      body['model'] = {
        id,
        ...(params ? { params: Object.entries(params).map(([pid, value]) => ({ id: pid, value })) } : {}),
      };
    }

    const json = await this.api<{ agent: { id: string }; run: { id: string } }>(
      'POST', '/v1/agents', body,
    );
    this.log(`launched agent ${json.agent.id} run ${json.run.id}`);
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
        await this.api('POST', `/v1/agents/${handle.agentId}/runs/${handle.runId}/cancel`).catch(() => {});
        throw new RunBudgetExceeded(handle.runId, this.opts.maxRunMinutes);
      }
      this.log(`agent ${handle.agentId} run ${handle.runId}: ${run.status}`);
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }

  async usage(agentId: string): Promise<TokenUsage | undefined> {
    try {
      const json = await this.api<{ totalUsage: TokenUsage; cost?: { chargedCents?: number } }>(
        'GET', `/v1/agents/${agentId}/usage`,
      );
      const costCents = json.cost?.chargedCents;
      return { ...json.totalUsage, ...(costCents !== undefined ? { costCents } : {}) };
    } catch {
      return undefined; // usage is telemetry-only; never fail the pipeline on it
    }
  }
}
