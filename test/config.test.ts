import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { agentCredentials, loadConfig } from '../src/config.ts';

function configDir(worker: Record<string, unknown>): string {
  const dir = mkdtempSync(resolve(tmpdir(), 'factory-config-'));
  writeFileSync(resolve(dir, 'factory.config.json'), JSON.stringify({
    repo: { owner: 'o', name: 'r', url: 'https://github.com/o/r' },
    worker: { kind: 'cursor', model: null, pollIntervalSeconds: 30, maxRunMinutes: 90, ...worker },
    labels: { factoryPr: 'factory', issueInProgress: 'factory:wip', groomed: 'factory:groomed', needsWork: 'factory:needs-work' },
    groom: { maxPerTick: 5, principlesFile: 'principles.example.md' },
    selector: { enabled: false, maxCandidates: 100 },
  }));
  return dir;
}

describe('agent credentials', () => {
  it('a config that predates agentEnv hands over nothing', () => {
    const config = loadConfig(configDir({}));
    expect(config.worker.agentEnv).toEqual([]);
    expect(agentCredentials(config, {})).toEqual({ present: [], values: {}, missing: [] });
  });

  it('only what is set here is forwarded; the rest is named as missing', () => {
    const config = loadConfig(configDir({ agentEnv: [
      { name: 'MODEL_API_KEY', description: 'Model provider' },
      { name: 'OPENAI_API_KEY', description: 'OpenAI' },
    ] }));
    const creds = agentCredentials(config, { MODEL_API_KEY: 'AQ.x', OPENAI_API_KEY: '' });
    expect(creds.present.map((c) => c.name)).toEqual(['MODEL_API_KEY']);
    expect(creds.values).toEqual({ MODEL_API_KEY: 'AQ.x' });
    expect(creds.missing).toEqual(['OPENAI_API_KEY']);
  });

  it('refuses a name Cursor would reject, and a credential with nothing to say about it', () => {
    expect(() => loadConfig(configDir({ agentEnv: [{ name: 'CURSOR_THING', description: 'x' }] }))).toThrow(/not a usable environment variable name/);
    expect(() => loadConfig(configDir({ agentEnv: [{ name: 'has-dash', description: 'x' }] }))).toThrow(/not a usable environment variable name/);
    expect(() => loadConfig(configDir({ agentEnv: [{ name: 'OK_NAME', description: '' }] }))).toThrow(/needs a description/);
  });
});

describe('model override', () => {
  const models = {
    opus: { id: 'claude-opus-5-5', params: { effort: 'medium' } },
    grok: { id: 'grok-4.7', params: { reasoning_effort: 'medium' } },
  };
  const withModel = (value: string | undefined, fn: () => void) => {
    const prev = process.env['FACTORY_MODEL'];
    if (value === undefined) delete process.env['FACTORY_MODEL']; else process.env['FACTORY_MODEL'] = value;
    try { fn(); } finally {
      if (prev === undefined) delete process.env['FACTORY_MODEL']; else process.env['FACTORY_MODEL'] = prev;
    }
  };

  it('an empty FACTORY_MODEL leaves worker.model as configured', () => {
    withModel('', () => {
      expect(loadConfig(configDir({ model: models.opus, models })).worker.model).toEqual(models.opus);
    });
  });

  it('FACTORY_MODEL runs the named model instead', () => {
    withModel('grok', () => {
      expect(loadConfig(configDir({ model: models.opus, models })).worker.model).toEqual(models.grok);
    });
  });

  it('refuses a name worker.models does not have', () => {
    withModel('gpt', () => {
      expect(() => loadConfig(configDir({ model: models.opus, models }))).toThrow(/names no model/);
    });
    withModel('grok', () => {
      expect(() => loadConfig(configDir({}))).toThrow(/has: none/);
    });
  });
});
