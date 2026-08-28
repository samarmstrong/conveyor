import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { GroomRecord, OutcomeRecord, RunRecord, TelemetryRecord } from './types.ts';

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

  /** PRs we opened that do not yet have a recorded human outcome (one entry per PR). */
  prsAwaitingOutcome(): RunRecord[] {
    const seen = new Set(this.outcomes().map((o) => o.prUrl));
    const awaiting: RunRecord[] = [];
    for (const r of this.runs()) {
      if (r.prUrl === null || seen.has(r.prUrl)) continue;
      seen.add(r.prUrl);
      awaiting.push(r);
    }
    return awaiting;
  }
}
