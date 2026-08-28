import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ModelSpec } from './types.ts';

export interface FactoryConfig {
  repo: { owner: string; name: string; url: string };
  worker: {
    model: ModelSpec | null;
    pollIntervalSeconds: number;
    maxRunMinutes: number;
  };
  labels: {
    factoryPr: string;
    issueInProgress: string;
    groomed: string;
    needsWork: string;
  };
  groom: { maxPerTick: number; principlesFile: string };
  selector: { maxCandidates: number };
  telemetryDir: string;
  staleRunHours: number;
}

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Minimal .env loader: KEY=value lines, no expansion. Never overrides real env. */
export function loadDotEnv(root: string = projectRoot): void {
  const envPath = resolve(root, '.env');
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const key = m[1]!;
    const value = m[2]!.replace(/^["']|["']$/g, '');
    if (!(key in process.env)) process.env[key] = value;
  }
}

export function loadConfig(root: string = projectRoot): FactoryConfig {
  const path = resolve(root, 'factory.config.json');
  if (!existsSync(path)) {
    throw new Error(
      `factory.config.json not found at ${path} — copy factory.config.example.json and point it at your target repo.`,
    );
  }
  return JSON.parse(readFileSync(path, 'utf8')) as FactoryConfig;
}

/** The product-direction principles grooming judges against. Factory-local by
 *  design: they are about what to build, and never reach the implementer. */
export function loadPrinciples(config: FactoryConfig, root: string = projectRoot): string {
  const path = resolve(root, config.groom.principlesFile);
  if (!existsSync(path)) {
    throw new Error(`groom.principlesFile not found: ${path}`);
  }
  return readFileSync(path, 'utf8').trim();
}

export function repoSlug(config: FactoryConfig): string {
  return `${config.repo.owner}/${config.repo.name}`;
}

export function requireCursorApiKey(): string {
  const key = process.env['CURSOR_API_KEY'];
  if (!key) {
    throw new Error(
      'CURSOR_API_KEY is not set. Create one at https://cursor.com/dashboard → API Keys, then put it in .env or the environment.',
    );
  }
  return key;
}
