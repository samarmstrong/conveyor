import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const listPrsByLabel = vi.fn();
const listIssuesByLabel = vi.fn<(...args: unknown[]) => Promise<{ number: number }[]>>(async () => []);
const removeIssueLabels = vi.fn(async (_repo: string, _issue: number, _labels: string[]) => {});
vi.mock('../src/github.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/github.ts')>()),
  listPrsByLabel: (...args: unknown[]) => listPrsByLabel(...args),
  listIssuesByLabel: (...args: unknown[]) => listIssuesByLabel(...args as [string, string]),
  removeIssueLabels: (repo: string, issue: number, labels: string[]) => removeIssueLabels(repo, issue, labels),
}));

const { FactoryState } = await import('../src/state.ts');
const { Telemetry } = await import('../src/telemetry.ts');
import type { FactoryConfig } from '../src/config.ts';
import type { CurrentRun } from '../src/types.ts';

function config(maxConcurrentJobs: number): FactoryConfig {
  return {
    repo: { owner: 'o', name: 'r', url: 'https://github.com/o/r' },
    worker: { model: null, pollIntervalSeconds: 30, maxRunMinutes: 90 },
    labels: { factoryPr: 'factory', issueInProgress: 'factory:wip', groomed: 'factory:groomed', needsWork: 'factory:needs-work', environmentPr: 'factory:env', simplifyPr: 'factory:simplify', epic: 'type:epic' },
    groom: { maxPerTick: 5, principlesFile: 'principles.example.md' },
    selector: { maxCandidates: 100 },
    environment: { enabled: true, maxPrsPerPass: 3 },
    simplify: { enabled: true },
    assignedIssues: { groom: true, implement: false },
    telemetryDir: 'telemetry',
    staleRunHours: 24,
    maxConcurrentJobs,
  };
}

function stateFor(maxConcurrentJobs: number, dir = mkdtempSync(resolve(tmpdir(), 'factory-state-'))) {
  return { state: new FactoryState(config(maxConcurrentJobs), new Telemetry(dir), dir), dir };
}

function openPrs(n: number) {
  return Array.from({ length: n }, (_, i) => ({ url: `https://github.com/o/r/pull/${i + 1}`, title: `pr ${i + 1}` }));
}

function run(issueNumber: number, over: Partial<CurrentRun> = {}): CurrentRun {
  return {
    taskId: `o/r#${issueNumber}`,
    issueNumber,
    agentId: `agent-${issueNumber}`,
    runId: `run-${issueNumber}`,
    startedAt: new Date().toISOString(),
    prUrl: null,
    ...over,
  };
}

describe('capacity', () => {
  beforeEach(() => {
    listPrsByLabel.mockReset();
    removeIssueLabels.mockClear();
  });

  it('is used up by the first open PR when the limit is 1', async () => {
    listPrsByLabel.mockResolvedValue(openPrs(1));
    const { state } = stateFor(1);
    expect((await state.capacity(() => {})).slots).toBe(0);
  });

  it('leaves a slot when the limit is 2 and one PR is open', async () => {
    listPrsByLabel.mockResolvedValue(openPrs(1));
    const { state } = stateFor(2);
    const capacity = await state.capacity(() => {});
    expect(capacity).toMatchObject({ limit: 2, slots: 1, openPrs: openPrs(1), inFlight: [] });
  });

  it('is used up once open PRs reach the limit', async () => {
    listPrsByLabel.mockResolvedValue(openPrs(2));
    const { state } = stateFor(2);
    expect((await state.capacity(() => {})).slots).toBe(0);
  });

  it('does not go negative when open PRs exceed a lowered limit', async () => {
    listPrsByLabel.mockResolvedValue(openPrs(3));
    const { state } = stateFor(2);
    expect((await state.capacity(() => {})).slots).toBe(0);
  });

  it('counts in-flight pipelines against the limit alongside open PRs', async () => {
    listPrsByLabel.mockResolvedValue(openPrs(1));
    const { state } = stateFor(3);
    const inFlight = run(11);
    state.writeRun(inFlight);
    const capacity = await state.capacity(() => {});
    expect(capacity.slots).toBe(1);
    expect(capacity.inFlight).toEqual([inFlight]);
  });

  it('counts a pipeline that already opened its PR only once', async () => {
    const prs = openPrs(1);
    listPrsByLabel.mockResolvedValue(prs);
    const { state } = stateFor(2);
    state.writeRun(run(11, { prUrl: prs[0]!.url }));
    expect((await state.capacity(() => {})).slots).toBe(1);
  });

  it('reclaims the slot of a stale pipeline, recording it as aborted', async () => {
    listPrsByLabel.mockResolvedValue([]);
    const { state, dir } = stateFor(1);
    const startedAt = new Date(Date.now() - 30 * 3_600_000).toISOString();
    state.writeRun(run(11, { startedAt }));

    const capacity = await state.capacity(() => {});
    expect(capacity.slots).toBe(1);
    expect(capacity.inFlight).toEqual([]);
    expect(state.readRuns()).toEqual([]);
    expect(removeIssueLabels).toHaveBeenCalledWith('o/r', 11, ['factory:wip']);

    const aborted = new Telemetry(dir).runs().filter((r) => r.outcome === 'aborted');
    expect(aborted).toHaveLength(1);
    expect(aborted[0]!.failureReason).toMatch(/stale pipeline older than 24h/);
  });
});

describe('run records', () => {
  beforeEach(() => listPrsByLabel.mockReset());

  it('holds one record per pipeline and upserts by taskId', () => {
    const { state } = stateFor(2);
    state.writeRun(run(11));
    state.writeRun(run(12));
    state.writeRun(run(11, { prUrl: 'https://github.com/o/r/pull/9' }));

    expect(state.readRuns()).toHaveLength(2);
    expect(state.readRun('o/r#11')?.prUrl).toBe('https://github.com/o/r/pull/9');

    state.clearRun('o/r#11');
    expect(state.readRuns().map((r) => r.taskId)).toEqual(['o/r#12']);
    state.clearRun('o/r#12');
    expect(state.readRuns()).toEqual([]);
  });

  it('migrates a pre-concurrency current-run.json into the array file', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'factory-state-'));
    const legacy = run(11);
    writeFileSync(resolve(dir, 'current-run.json'), JSON.stringify(legacy));

    const { state } = stateFor(2, dir);
    expect(state.readRuns()).toEqual([legacy]);
    expect(existsSync(resolve(dir, 'current-run.json'))).toBe(false);
  });
});

describe('reconcileOutcomes', () => {
  beforeEach(() => {
    listPrsByLabel.mockReset();
    listIssuesByLabel.mockReset();
    listIssuesByLabel.mockResolvedValue([]);
    removeIssueLabels.mockClear();
  });

  const pr = (n: number, state: 'OPEN' | 'MERGED' | 'CLOSED', body = '') => ({
    url: `https://github.com/o/r/pull/${n}`, state, body, reviews: [], comments: [],
    mergedAt: state === 'MERGED' ? 'then' : null, closedAt: state === 'OPEN' ? null : 'then',
  });

  /** GitHub answers per label: implementer PRs, environment PRs, simplify PRs. */
  function github(byLabel: Record<string, unknown[]>) {
    listPrsByLabel.mockImplementation(async (_repo: string, label: string) => byLabel[label] ?? []);
  }

  it('records an environment PR outcome and releases no issue label', async () => {
    const { state, dir } = stateFor(1);
    github({ 'factory:env': [pr(7, 'MERGED')] });

    expect(await state.reconcileOutcomes(() => {})).toBe(1);
    expect(new Telemetry(dir).outcomes()[0]).toMatchObject({ source: 'environment', merged: true, issueNumber: null });
    expect(removeIssueLabels).not.toHaveBeenCalled();
  });

  it('records an implementer PR with the issue it closed', async () => {
    const { state, dir } = stateFor(1);
    github({ factory: [pr(8, 'CLOSED', 'Closes #42')] });

    expect(await state.reconcileOutcomes(() => {})).toBe(1);
    expect(new Telemetry(dir).outcomes()[0]).toMatchObject({ source: 'implementer', merged: false, issueNumber: 42 });
  });

  it('leaves an open PR alone so it is reconciled on a later tick', async () => {
    const { state, dir } = stateFor(1);
    github({ 'factory:env': [pr(9, 'OPEN')] });

    expect(await state.reconcileOutcomes(() => {})).toBe(0);
    expect(new Telemetry(dir).outcomes()).toEqual([]);
  });

  it('does not record a PR twice, so the record survives a second look', async () => {
    const { state, dir } = stateFor(1);
    github({ factory: [pr(8, 'MERGED', 'Closes #42')] });

    expect(await state.reconcileOutcomes(() => {})).toBe(1);
    expect(await state.reconcileOutcomes(() => {})).toBe(0);
    expect(new Telemetry(dir).outcomes()).toHaveLength(1);
  });

  it('releases the wip label on an issue whose PR has closed', async () => {
    const { state } = stateFor(1);
    github({ factory: [pr(8, 'MERGED', 'Closes #42')] });
    listIssuesByLabel.mockResolvedValue([{ number: 42 }]);

    await state.reconcileOutcomes(() => {});
    expect(removeIssueLabels).toHaveBeenCalledWith('o/r', 42, ['factory:wip']);
  });

  it('keeps the label while an open factory PR or a running pipeline claims the issue', async () => {
    const { state } = stateFor(2);
    github({ factory: [pr(8, 'OPEN', 'Closes #42')] });
    state.writeRun(run(43));
    listIssuesByLabel.mockResolvedValue([{ number: 42 }, { number: 43 }]);

    await state.reconcileOutcomes(() => {});
    expect(removeIssueLabels).not.toHaveBeenCalled();
  });

  it('releases a label a crashed tick leaked, with no PR ever recorded', async () => {
    // Nothing in telemetry knows about #44; GitHub says it is claimed and nothing is working on it.
    const { state } = stateFor(1);
    github({});
    listIssuesByLabel.mockResolvedValue([{ number: 44 }]);

    await state.reconcileOutcomes(() => {});
    expect(removeIssueLabels).toHaveBeenCalledWith('o/r', 44, ['factory:wip']);
  });
});
