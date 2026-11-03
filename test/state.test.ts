import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const listPrsByLabel = vi.fn();
const ghLogin = vi.fn(async () => 'factory-bot');
const listIssuesByLabel = vi.fn<(...args: unknown[]) => Promise<{ number: number }[]>>(async () => []);
const removeIssueLabels = vi.fn(async (_repo: string, _issue: number, _labels: string[]) => {});
const listOpenPrs = vi.fn<(...args: unknown[]) => Promise<unknown[]>>(async () => []);
const referenceState = vi.fn(async (_repo: string, _n: number) => 'open' as 'open' | 'closed' | 'unknown');
const markPrReady = vi.fn(async (_repo: string, _url: string) => {});
const addPrLabels = vi.fn(async (_repo: string, _url: string, _labels: string[]) => {});
const addIssueLabels = vi.fn(async (_repo: string, _issue: number, _labels: string[]) => {});
const closePr = vi.fn(async (_repo: string, _url: string, _comment: string) => {});
const commentOnIssue = vi.fn(async (_repo: string, _issue: number, _body: string) => {});
const commentOnPr = vi.fn(async (_repo: string, _url: string, _body: string) => {});
const ensureLabel = vi.fn(async (..._args: unknown[]) => {});
const prMergeable = vi.fn(async (_repo: string, _url: string) => ({ mergeable: 'MERGEABLE' as 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN', baseRefName: 'main' }));
/** By default every issue was claimed two days ago, past any runner's pipeline. */
const twoDaysAgo = () => new Date(Date.now() - 48 * 3_600_000).toISOString();
const labelHistory = vi.fn(async (_repo: string, issues: number[]) =>
  new Map<number, LabelHistory>(issues.map((n) => [n, { open: true, labels: ['factory:wip'], labelledAt: { 'factory:wip': twoDaysAgo() } }])));
vi.mock('../src/github.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/github.ts')>()),
  listOpenPrs: (...args: unknown[]) => listOpenPrs(...args),
  referenceState: (repo: string, n: number) => referenceState(repo, n),
  markPrReady: (repo: string, url: string) => markPrReady(repo, url),
  addPrLabels: (repo: string, url: string, labels: string[]) => addPrLabels(repo, url, labels),
  addIssueLabels: (repo: string, issue: number, labels: string[]) => addIssueLabels(repo, issue, labels),
  closePr: (repo: string, url: string, comment: string) => closePr(repo, url, comment),
  commentOnIssue: (repo: string, issue: number, body: string) => commentOnIssue(repo, issue, body),
  commentOnPr: (repo: string, url: string, body: string) => commentOnPr(repo, url, body),
  ensureLabel: (...args: unknown[]) => ensureLabel(...args),
  prMergeable: (repo: string, url: string) => prMergeable(repo, url),
  labelHistory: (repo: string, issues: number[]) => labelHistory(repo, issues),
  listPrsByLabel: (...args: unknown[]) => listPrsByLabel(...args),
  ghLogin: () => ghLogin(),
  listIssuesByLabel: (...args: unknown[]) => listIssuesByLabel(...args as [string, string]),
  removeIssueLabels: (repo: string, issue: number, labels: string[]) => removeIssueLabels(repo, issue, labels),
}));

const { FactoryState } = await import('../src/state.ts');
const { Telemetry } = await import('../src/telemetry.ts');
import type { FactoryConfig } from '../src/config.ts';
import type { LabelHistory } from '../src/github.ts';
import type { CurrentRun } from '../src/types.ts';

function config(maxConcurrentJobs: number): FactoryConfig {
  return {
    repo: { owner: 'o', name: 'r', url: 'https://github.com/o/r' },
    worker: { kind: 'cursor', model: null, models: {}, pollIntervalSeconds: 30, maxRunMinutes: 90, agentEnv: [] },
    labels: { factoryPr: 'factory', issueInProgress: 'factory:wip', groomed: 'factory:groomed', needsWork: 'factory:needs-work', environmentPr: 'factory:env', simplifyPr: 'factory:simplify', reviewPr: 'factory:review', depsPr: 'factory:deps', epic: 'type:epic', blocker: 'factory:blocker', securityPr: 'factory:security', draft: 'factory:draft', grooming: 'factory:grooming', reviewing: 'factory:reviewing' },
    groom: { maxPerTick: 5, principlesFile: 'principles.example.md' },
    selector: { enabled: false, maxCandidates: 100 },
    environment: { enabled: true, maxPrsPerPass: 3 },
    simplify: { enabled: true },
    review: { enabled: false, maxPerTick: 3 },
    deps: { enabled: false },
    security: { enabled: false, minSeverity: 'high' },
    assignedIssues: { groom: true, implement: false },
    telemetryDir: 'telemetry',
    staleRunHours: 24,
    maxConcurrentJobs,
  };
}

function stateFor(maxConcurrentJobs: number, dir = mkdtempSync(resolve(tmpdir(), 'factory-state-'))) {
  return { state: new FactoryState(config(maxConcurrentJobs), new Telemetry(dir), dir), dir };
}

function openPrs(n: number, author = 'factory-bot') {
  return Array.from({ length: n }, (_, i) => ({ url: `https://github.com/o/r/pull/${i + 1}`, title: `pr ${i + 1}`, author: { login: author } }));
}

const bare = (prs: { url: string; title: string }[]) => prs.map(({ url, title }) => ({ url, title }));

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
    expect(capacity).toMatchObject({ limit: 2, slots: 1, openPrs: bare(openPrs(1)), inFlight: [] });
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

  it('counts only the PRs this runner opened, not another runner\'s under the same label', async () => {
    const theirs = openPrs(3, 'someone-else').map((pr, i) => ({ ...pr, url: `https://github.com/o/r/pull/${i + 10}` }));
    listPrsByLabel.mockResolvedValue([...openPrs(1), ...theirs]);
    const { state } = stateFor(3);
    const capacity = await state.capacity(() => {});
    expect(capacity.openPrs).toEqual(bare(openPrs(1)));
    expect(capacity.slots).toBe(2);
  });

  it('counts every PR when it cannot tell who this runner is', async () => {
    ghLogin.mockRejectedValueOnce(new Error('HTTP 403'));
    listPrsByLabel.mockResolvedValue([...openPrs(1), ...openPrs(1, 'someone-else')]);
    const { state } = stateFor(3);
    expect((await state.capacity(() => {})).slots).toBe(1);
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

  it('reclaims at once the slot of a pipeline whose tick process is gone, and keeps a live one', async () => {
    listPrsByLabel.mockResolvedValue([]);
    const { state } = stateFor(2);
    // Pid 2^22+ is past macOS and Linux pid ranges: nothing runs under it.
    state.writeRun(run(11, { pid: 4_194_400 }));
    state.writeRun(run(12, { pid: process.pid }));
    const capacity = await state.capacity(() => {});
    expect(capacity.inFlight.map((r) => r.issueNumber)).toEqual([12]);
    expect(capacity.slots).toBe(1);
    expect(removeIssueLabels).toHaveBeenCalledWith('o/r', 11, ['factory:wip']);
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
    labelHistory.mockClear();
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

  it('holds a fresh claim nothing here holds: a pipeline on another runner may be building it', async () => {
    const { state } = stateFor(1);
    github({});
    listIssuesByLabel.mockResolvedValue([{ number: 2269 }]);
    labelHistory.mockImplementationOnce(async () => new Map([[2269, { open: true, labels: ['factory:wip'], labelledAt: { 'factory:wip': new Date(Date.now() - 3_600_000).toISOString() } }]]));

    await state.reconcileOutcomes(() => {});
    expect(removeIssueLabels).not.toHaveBeenCalled();
  });

  it('releases a fresh claim at once when its factory PR has closed since', async () => {
    const { state } = stateFor(1);
    const claimed = new Date(Date.now() - 3_600_000).toISOString();
    github({ factory: [{ ...pr(8, 'CLOSED', 'Closes #42'), closedAt: new Date().toISOString() }] });
    listIssuesByLabel.mockResolvedValue([{ number: 42 }]);
    labelHistory.mockImplementationOnce(async () => new Map([[42, { open: true, labels: ['factory:wip'], labelledAt: { 'factory:wip': claimed } }]]));

    await state.reconcileOutcomes(() => {});
    expect(removeIssueLabels).toHaveBeenCalledWith('o/r', 42, ['factory:wip']);
  });

  it('retires the groom verdict of an issue a merged factory PR left open, and says why', async () => {
    const { state } = stateFor(1);
    github({ factory: [{ ...pr(1775, 'MERGED', 'Part of #1712'), mergedAt: new Date().toISOString() }] });
    labelHistory.mockImplementationOnce(async () => new Map([[1712, { open: true, labels: ['factory:groomed'], labelledAt: { 'factory:groomed': twoDaysAgo() } }]]));

    await state.reconcileOutcomes(() => {});
    expect(labelHistory).toHaveBeenLastCalledWith('o/r', [1712]);
    expect(removeIssueLabels).toHaveBeenCalledWith('o/r', 1712, ['factory:groomed']);
    expect(commentOnIssue.mock.calls.at(-1)![2]).toContain('pull/1775 merged and this issue is still open');
  });
});

describe('reconcileOutcomes: what a dead pipeline left behind', () => {
  beforeEach(() => {
    for (const m of [listPrsByLabel, listOpenPrs, referenceState, markPrReady, addPrLabels, addIssueLabels, closePr, commentOnIssue, commentOnPr, prMergeable]) m.mockClear();
    prMergeable.mockResolvedValue({ mergeable: 'MERGEABLE', baseRefName: 'main' });
    listPrsByLabel.mockReset();
    listPrsByLabel.mockResolvedValue([]);
    listOpenPrs.mockResolvedValue([]);
    referenceState.mockResolvedValue('open');
  });

  const open = (n: number, over: Record<string, unknown> = {}) => ({
    number: n, url: `https://github.com/o/r/pull/${n}`, state: 'OPEN', isDraft: true, labels: [],
    headRefName: `cursor/factory-42-the-issue-title-${n}`, body: 'Closes #42', reviews: [], comments: [], ...over,
  });

  it('adopts an unlabelled draft from a factory branch: ready, labelled, its issue claimed', async () => {
    const { state } = stateFor(3);
    listOpenPrs.mockResolvedValue([open(9)]);

    await state.reconcileOutcomes(() => {});
    expect(markPrReady).toHaveBeenCalledWith('o/r', 'https://github.com/o/r/pull/9');
    expect(addPrLabels).toHaveBeenCalledWith('o/r', 'https://github.com/o/r/pull/9', ['factory']);
    expect(addIssueLabels).toHaveBeenCalledWith('o/r', 42, ['factory:wip']);
    expect(commentOnIssue.mock.calls[0]![2]).toContain('nobody watched its CI');
    expect(closePr).not.toHaveBeenCalled();
  });

  it('leaves alone an unlabelled PR younger than the run budget, and holds its issue: another runner\'s pipeline may be about to label it', async () => {
    const { state } = stateFor(3);
    const createdAt = new Date().toISOString();
    listOpenPrs.mockResolvedValue([open(9, { createdAt }), open(23, { createdAt, headRefName: 'cursor/factory-review-1493-test-drop-ab06' })]);
    listIssuesByLabel.mockResolvedValue([{ number: 42 }]);
    removeIssueLabels.mockClear();

    await state.reconcileOutcomes(() => {});
    expect(addPrLabels).not.toHaveBeenCalled();
    expect(closePr).not.toHaveBeenCalled();
    expect(removeIssueLabels).not.toHaveBeenCalled();
    listIssuesByLabel.mockResolvedValue([]);
  });

  it('closes an orphan whose issue another factory PR already answers', async () => {
    const { state } = stateFor(3);
    listOpenPrs.mockResolvedValue([open(9), open(10, { isDraft: false, labels: [{ name: 'factory' }] })]);

    await state.reconcileOutcomes(() => {});
    expect(closePr.mock.calls[0]![1]).toBe('https://github.com/o/r/pull/9');
    expect(closePr.mock.calls[0]![2]).toContain('pull/10 already answers #42');
    expect(addPrLabels).not.toHaveBeenCalled();
  });

  it('closes an orphan whose issue has closed, and adopts only one of two for the same issue', async () => {
    const { state } = stateFor(3);
    listOpenPrs.mockResolvedValue([open(9), open(10)]);
    await state.reconcileOutcomes(() => {});
    expect(addPrLabels).toHaveBeenCalledTimes(1);
    expect(closePr).toHaveBeenCalledTimes(1);

    closePr.mockClear();
    referenceState.mockResolvedValue('closed');
    listOpenPrs.mockResolvedValue([open(11)]);
    await state.reconcileOutcomes(() => {});
    expect(closePr.mock.calls[0]![2]).toContain('#42 has closed');
  });

  it('leaves alone a PR that is not the factory implementer\'s', async () => {
    const { state } = stateFor(3);
    listOpenPrs.mockResolvedValue([
      open(9, { headRefName: 'feat/a-human-branch' }),
      open(11, { body: 'Closes #7' }),
      open(12, { headRefName: 'cursor/factory-security-ab52', labels: [{ name: 'factory:security' }] }),
    ]);

    await state.reconcileOutcomes(() => {});
    expect(addPrLabels).not.toHaveBeenCalled();
    expect(closePr).not.toHaveBeenCalled();
  });

  it('adopts another phase\'s orphan under its own label, and a security one claims the alerts it names', async () => {
    const { state } = stateFor(3);
    listOpenPrs.mockResolvedValue([
      open(20, { headRefName: 'cursor/factory-security-ab52', body: 'Fixes dependabot#95 and code-scanning#4; dependabot#95 again.' }),
      open(21, { headRefName: 'cursor/factory-simplify-b961', body: 'Closes #42' }),
    ]);

    await state.reconcileOutcomes(() => {});
    expect(addPrLabels).toHaveBeenCalledWith('o/r', 'https://github.com/o/r/pull/20', ['factory:security']);
    expect(addPrLabels).toHaveBeenCalledWith('o/r', 'https://github.com/o/r/pull/21', ['factory:simplify']);
    expect(markPrReady).toHaveBeenCalledWith('o/r', 'https://github.com/o/r/pull/20');
    expect(commentOnPr.mock.calls[0]![2]).toContain('<!-- factory-security alerts=dependabot#95,code-scanning#4 -->');
    expect(commentOnPr.mock.calls[1]![2]).not.toContain('factory-security');
    // Not mistaken for issue #42's implementer PR.
    expect(addIssueLabels).not.toHaveBeenCalled();
    expect(closePr).not.toHaveBeenCalled();
  });

  it('closes a phase orphan that conflicts, and every review orphan', async () => {
    const { state } = stateFor(3);
    prMergeable.mockResolvedValue({ mergeable: 'CONFLICTING', baseRefName: 'main' });
    listOpenPrs.mockResolvedValue([
      open(22, { headRefName: 'cursor/factory-security-ab52' }),
      open(23, { headRefName: 'cursor/factory-review-1493-test-drop-ab06' }),
    ]);

    await state.reconcileOutcomes(() => {});
    expect(closePr.mock.calls.map((c) => c[1])).toEqual(['https://github.com/o/r/pull/22', 'https://github.com/o/r/pull/23']);
    expect(closePr.mock.calls[0]![2]).toContain('conflicts with the default branch');
    expect(closePr.mock.calls[1]![2]).toContain('reviewed again');
    expect(prMergeable).toHaveBeenCalledTimes(1);
    expect(addPrLabels).not.toHaveBeenCalled();
  });

  it('takes a labelled factory PR out of draft', async () => {
    const { state } = stateFor(3);
    listPrsByLabel.mockImplementation(async (_repo: string, label: string) =>
      label === 'factory' ? [{ ...open(12, { labels: [{ name: 'factory' }] }), mergedAt: null, closedAt: null }] : []);

    await state.reconcileOutcomes(() => {});
    expect(markPrReady).toHaveBeenCalledWith('o/r', 'https://github.com/o/r/pull/12');
  });
});

