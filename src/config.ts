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
    /** Carried by the environment agent's PRs, and by nothing else — this is
     *  what keeps them out of the `maxConcurrentJobs` count. */
    environmentPr: string;
    /** Likewise for the simplification agent's PRs. */
    simplifyPr: string;
    /** The repo's own epic label. An issue carrying it is groomed as a
     *  direction — the groomer settles its open decisions and writes its
     *  children — and is never handed to the selector. Not a factory label:
     *  the repo already has one, and a human applies it. */
    epic: string;
  };
  groom: { maxPerTick: number; principlesFile: string };
  selector: { maxCandidates: number };
  /** The environment phase: an agent that reads the factory's own PRs looking
   *  for checks the implementer could not run, and fixes the cloud-agent
   *  environment so the next one can. `maxPrsPerPass` bounds how many PRs one
   *  pass reads; only one environment PR is ever open at a time. */
  environment: { enabled: boolean; maxPrsPerPass: number };
  /** The simplification phase: an agent whose only job is to open a PR that
   *  removes more code than it adds. One such PR is open at a time. */
  simplify: { enabled: boolean };
  /**
   * Whether a phase may act on an issue a human has assigned to themselves.
   * Grooming defaults to true — vetting costs the assignee nothing and the
   * verdict is useful to them — and implementation to false, because two agents
   * on one issue is the collision the factory exists to avoid.
   */
  assignedIssues: { groom: boolean; implement: boolean };
  telemetryDir: string;
  staleRunHours: number;
  /** The throttle, in one number: how many jobs may exist at once, counting
   *  open factory PRs awaiting a human and pipelines still running. It is also
   *  the most pipelines one tick will start. 1 = strict one-at-a-time. */
  maxConcurrentJobs: number;
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
  const config = JSON.parse(readFileSync(path, 'utf8')) as FactoryConfig;
  // A committed factory.config.json can predate a field the engine has since
  // grown, so a missing one is simply absent. Default to the original
  // one-job-at-a-time throttle rather than failing the next tick.
  config.maxConcurrentJobs ??= 1;
  if (!Number.isInteger(config.maxConcurrentJobs) || config.maxConcurrentJobs < 1) {
    throw new Error(
      `maxConcurrentJobs must be a positive integer, got ${JSON.stringify(config.maxConcurrentJobs)}`,
    );
  }
  config.labels.environmentPr ??= 'factory:env';
  config.labels.simplifyPr ??= 'factory:simplify';
  config.labels.epic ??= 'type:epic';
  config.simplify ??= { enabled: true };
  // Narrowing what the factory touches is the safe direction for a deployment
  // that pulls this in without asking for it, so this defaults on rather than
  // preserving the old take-anything behavior.
  config.assignedIssues ??= { groom: true, implement: false };
  config.environment ??= { enabled: true, maxPrsPerPass: 3 };
  config.environment.maxPrsPerPass ??= 3;
  if (!Number.isInteger(config.environment.maxPrsPerPass) || config.environment.maxPrsPerPass < 1) {
    throw new Error(
      `environment.maxPrsPerPass must be a positive integer, got ${JSON.stringify(config.environment.maxPrsPerPass)}`,
    );
  }
  return config;
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
