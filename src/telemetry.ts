import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { EnvRecord, GroomRecord, OutcomeRecord, RunRecord, SimplifyRecord, TelemetryRecord } from './types.ts';

/** A PR the factory opened whose human verdict has not been recorded yet. */
export interface AwaitingOutcome {
  prUrl: string;
  source: OutcomeRecord['source'];
  /** The issue the PR closes; null for environment PRs, which close none. */
  issueNumber: number | null;
}

export class Telemetry {
  private readonly file: string;

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.file = resolve(dir, 'runs.jsonl');
  }

  append(record: TelemetryRecord): void {
    appendFileSync(this.file, `${JSON.stringify(record)}\n`);
  }

  readAll(): TelemetryRecord[] {
    if (!existsSync(this.file)) return [];
    return readFileSync(this.file, 'utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as TelemetryRecord);
  }

  runs(): RunRecord[] {
    return this.readAll().filter((r): r is RunRecord => r.type === 'run');
  }

  grooms(): GroomRecord[] {
    return this.readAll().filter((r): r is GroomRecord => r.type === 'groom');
  }

  outcomes(): OutcomeRecord[] {
    return this.readAll().filter((r): r is OutcomeRecord => r.type === 'outcome');
  }

  envPasses(): EnvRecord[] {
    return this.readAll().filter((r): r is EnvRecord => r.type === 'env');
  }

  simplifyPasses(): SimplifyRecord[] {
    return this.readAll().filter((r): r is SimplifyRecord => r.type === 'simplify');
  }

  /**
   * PRs we opened that do not yet have a recorded human outcome (one entry per
   * PR). Every pipeline is here: an environment or simplification PR is reviewed
   * and merged by a human like any other, so its verdict belongs in the same
   * dataset — it just carries no issue. A simplification the factory itself
   * closed for growing the code never reached a human, so it is not awaited.
   */
  prsAwaitingOutcome(): AwaitingOutcome[] {
    const seen = new Set(this.outcomes().map((o) => o.prUrl));
    const awaiting: AwaitingOutcome[] = [];
    const add = (prUrl: string | null, source: OutcomeRecord['source'], issueNumber: number | null): void => {
      if (prUrl === null || seen.has(prUrl)) return;
      seen.add(prUrl);
      awaiting.push({ prUrl, source, issueNumber });
    };
    for (const r of this.runs()) add(r.prUrl, 'implementer', r.issueNumber);
    for (const e of this.envPasses()) add(e.prUrl, 'environment', null);
    for (const s of this.simplifyPasses()) if (s.outcome === 'pr-opened') add(s.prUrl, 'simplify', null);
    return awaiting;
  }
}
