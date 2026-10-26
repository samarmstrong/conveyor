import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CursorWorker, peakContextEstimate } from '../src/worker.ts';

const run = { inputTokens: 88, outputTokens: 15_771, cacheWriteTokens: 57_132, cacheReadTokens: 2_886_816, totalTokens: 2_959_807 };

describe('peakContextEstimate', () => {
  it('reads peak context from what entered it: uncached input plus cache writes', () => {
    expect(peakContextEstimate({ id: 'claude-opus-5-5', params: { context: '300k' } }, run)).toBe(61_527);
  });

  it('gives no estimate where the cache accounting does not support one', () => {
    expect(peakContextEstimate({ id: 'grok-4.7' }, run)).toBeUndefined();
    expect(peakContextEstimate(null, run)).toBeUndefined();
  });
});

describe('CursorWorker API retries', () => {
  const worker = () => new CursorWorker({
    apiKey: 'k', repoUrl: 'https://github.com/o/r', startingRef: null, model: null, pollIntervalSeconds: 1, maxRunMinutes: 5,
  });
  const dropped = () => Promise.reject(new TypeError('fetch failed', { cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }) }));
  const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status }));

  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('asks a dropped or 5xx poll again instead of failing the run', async () => {
    const fetch = vi.fn()
      .mockImplementationOnce(dropped)
      .mockImplementationOnce(() => json({ error: 'bad gateway' }, 502))
      .mockImplementationOnce(() => json({ id: 'run-1', status: 'FINISHED', result: 'VERDICT: groomed' }));
    vi.stubGlobal('fetch', fetch);
    const result = worker().awaitResult({ agentId: 'bc-1', runId: 'run-1' });
    await vi.runAllTimersAsync();
    await expect(result).resolves.toMatchObject({ status: 'FINISHED', resultText: 'VERDICT: groomed' });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('does not repeat a launch whose answer was lost, and says why it failed', async () => {
    const fetch = vi.fn().mockImplementation(dropped);
    vi.stubGlobal('fetch', fetch);
    await expect(worker().start('prompt')).rejects.toThrow('Cursor API POST /v1/agents: fetch failed (UND_ERR_SOCKET: other side closed)');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does not repeat a launch that timed out waiting for an answer: Cursor may have it', async () => {
    const fetch = vi.fn().mockImplementation(() => Promise.reject(new TypeError('fetch failed', { cause: Object.assign(new Error('Headers Timeout Error'), { code: 'UND_ERR_HEADERS_TIMEOUT' }) })));
    vi.stubGlobal('fetch', fetch);
    await expect(worker().start('prompt')).rejects.toThrow('UND_ERR_HEADERS_TIMEOUT');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('repeats a launch whose connection never opened, since nothing was sent', async () => {
    const fetch = vi.fn()
      .mockImplementationOnce(() => Promise.reject(new TypeError('fetch failed', { cause: Object.assign(new Error('Connect Timeout Error'), { code: 'UND_ERR_CONNECT_TIMEOUT' }) })))
      .mockImplementationOnce(() => Promise.reject(new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo EAI_AGAIN api.cursor.com'), { code: 'EAI_AGAIN' }) })))
      .mockImplementationOnce(() => json({ agent: { id: 'bc-1' }, run: { id: 'run-1' } }));
    vi.stubGlobal('fetch', fetch);
    const handle = worker().start('prompt');
    await vi.runAllTimersAsync();
    await expect(handle).resolves.toEqual({ agentId: 'bc-1', runId: 'run-1' });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('does not repeat a launch refused for usage: that is an answer, not a dropped line', async () => {
    const fetch = vi.fn().mockImplementation(() => json({ error: 'usage_limit_exceeded' }, 402));
    vi.stubGlobal('fetch', fetch);
    await expect(worker().start('prompt')).rejects.toThrow('402');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('runs the model a start asks for, else the worker\'s own', async () => {
    const fetch = vi.fn().mockImplementation(() => json({ agent: { id: 'bc-1' }, run: { id: 'run-1' } }));
    vi.stubGlobal('fetch', fetch);
    const w = new CursorWorker({
      apiKey: 'k', repoUrl: 'https://github.com/o/r', startingRef: null, model: { id: 'claude-sonnet-5-5', params: { reasoning_effort: 'high' } }, pollIntervalSeconds: 1, maxRunMinutes: 5,
    });
    await w.start('groom an epic', { model: { id: 'claude-fable-5-1', params: { effort: 'high' } } });
    await w.start('groom an issue');
    const sent = (i: number) => JSON.parse(fetch.mock.calls[i]![1].body as string).model;
    expect(sent(0)).toEqual({ id: 'claude-fable-5-1', params: [{ id: 'effort', value: 'high' }] });
    expect(sent(1)).toEqual({ id: 'claude-sonnet-5-5', params: [{ id: 'reasoning_effort', value: 'high' }] });
  });

  it('repeats a launch that was rate-limited, since nothing was created', async () => {
    const fetch = vi.fn()
      .mockImplementationOnce(() => json({ error: 'rate limited' }, 429))
      .mockImplementationOnce(() => json({ agent: { id: 'bc-1' }, run: { id: 'run-1' } }));
    vi.stubGlobal('fetch', fetch);
    const handle = worker().start('prompt');
    await vi.runAllTimersAsync();
    await expect(handle).resolves.toEqual({ agentId: 'bc-1', runId: 'run-1' });
  });

  it('gives up on a GET after the backoff runs out', async () => {
    const fetch = vi.fn().mockImplementation(dropped);
    vi.stubGlobal('fetch', fetch);
    const result = worker().awaitResult({ agentId: 'bc-1', runId: 'run-1' });
    const settled = expect(result).rejects.toThrow('fetch failed');
    await vi.runAllTimersAsync();
    await settled;
    expect(fetch).toHaveBeenCalledTimes(6);
  });
});
