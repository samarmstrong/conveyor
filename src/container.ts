// Containers for the claude-code worker's runs that need a machine of their own.
//
// A review of an outside PR verifies it against a fresh instance of the app:
// its own database, its own stack, nothing another agent left running. On
// Cursor every agent gets that VM. Here implementers share one machine and
// take turns at the live stack (localMachine.ts), which a review would queue
// behind for most of its budget. So a review runs in a Docker container of its
// own instead, built from the target repo's Cursor environment
// (`.cursor/environment.json` and the Dockerfile it names) with Claude Code and
// `gh` added, and Docker inside it. The environment's `install` and `start`
// then bring the stack up as they would on Cursor's VM, and the agent runs
// there. The container lives as long as the agent, since follow-ups for red
// checks run in it too, and is removed when the review is done or the tick
// that started it dies.

import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

import { pidAlive } from './localMachine.ts';

const execFileAsync = promisify(execFile);

/** On every container this module starts: the session it is. */
export const CONTAINER_LABEL = 'factory.container';
/** The pid of the tick that started it; a container whose tick is gone is swept. */
export const TICK_LABEL = 'factory.tick';
/** Where the environment's `install` and `start` write, in the agent's home. */
export const INSTALL_LOG = 'factory-install.log';
export const START_LOG = 'factory-start.log';
const INSTALL_TIMEOUT_MS = 40 * 60_000;
const START_TIMEOUT_MS = 20 * 60_000;

/** What `.cursor/environment.json` says about the machine, as this module needs it. */
export interface CursorEnvironment {
  /** Repo-relative path of the Dockerfile to build, or null for a plain Ubuntu. */
  dockerfile: string | null;
  user: string;
  install: string | null;
  start: string | null;
}

/** Cursor resolves `build.dockerfile` against the `.cursor/` directory. */
export function parseEnvironment(json: string): CursorEnvironment {
  const env = JSON.parse(json) as { build?: { dockerfile?: string }; user?: string; install?: string; start?: string };
  const dockerfile = env.build?.dockerfile ? resolve('/.cursor', env.build.dockerfile).slice(1) : null;
  return { dockerfile, user: env.user || 'root', install: env.install || null, start: env.start || null };
}

/** Where `user`'s home is in the image. */
export function homeOf(user: string): string {
  return user === 'root' ? '/root' : `/home/${user}`;
}

/**
 * The layer on top of the environment's image: what a Claude Code agent needs
 * that a Cursor one did not, pinned to the host's Claude Code version. And the
 * inner Docker on overlay2: a Cursor VM needs fuse-overlayfs, but under Docker
 * Desktop nothing on it can exec ("exec …: invalid argument"), while overlay2 on
 * the container's own /var/lib/docker volume runs the stack.
 */
export function agentLayer(base: string, user: string, claudeVersion: string): string {
  return `FROM ${base}
USER root
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends gh procps && rm -rf /var/lib/apt/lists/*
RUN if [ -f /etc/docker/daemon.json ]; then sed -i 's/"fuse-overlayfs"/"overlay2"/' /etc/docker/daemon.json; fi
USER ${user}
RUN curl -fsSL https://claude.ai/install.sh | bash -s ${claudeVersion}
ENV PATH=${homeOf(user)}/.local/bin:$PATH DISABLE_AUTOUPDATER=1
`;
}

const tagHash = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 12);

/**
 * The image a session's container runs: the environment's Dockerfile, then
 * the agent layer, each built only when no image carries its tag yet. The
 * build log is `logFile`.
 */
export async function ensureImage(docker: string, dockerfile: string | null, user: string, claudeVersion: string, logFile: string): Promise<string> {
  const env = dockerfile ?? 'FROM ubuntu:24.04\nRUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl git sudo && rm -rf /var/lib/apt/lists/*\n';
  const base = `factory-env:${tagHash(env)}`;
  const layer = agentLayer(base, user, claudeVersion);
  const image = `factory-agent:${tagHash(env + layer)}`;
  if (await imageExists(docker, image)) return image;
  if (!(await imageExists(docker, base))) await build(docker, base, env, logFile);
  await build(docker, image, layer, logFile);
  await pruneImages(docker, [base, image]);
  return image;
}

/** The factory's images other than `keep`: those from an older Dockerfile or Claude Code. */
export function staleImages(tags: string[], keep: string[]): string[] {
  return tags.filter((t) => /^factory-(env|agent):/.test(t) && !keep.includes(t));
}

/**
 * Each new Claude Code release or Dockerfile change tags a new image of a few
 * GB, and the old ones would fill the disk. One a container still runs keeps
 * (`docker rmi` refuses it) and goes with the next build.
 */
async function pruneImages(docker: string, keep: string[]): Promise<void> {
  const { stdout } = await execFileAsync(docker, ['images', '--format', '{{.Repository}}:{{.Tag}}']).catch(() => ({ stdout: '' }));
  for (const tag of staleImages(stdout.split('\n').filter(Boolean), keep)) {
    await execFileAsync(docker, ['rmi', tag]).catch(() => {});
  }
}

async function imageExists(docker: string, tag: string): Promise<boolean> {
  return execFileAsync(docker, ['image', 'inspect', tag]).then(() => true, () => false);
}

/** `docker build` from a Dockerfile on stdin and an empty context: Cursor
 *  builds the environment's the same way unless it names a context. */
function build(docker: string, tag: string, dockerfile: string, logFile: string): Promise<void> {
  const context = resolve(logFile, '..', 'build-context');
  mkdirSync(context, { recursive: true });
  writeFileSync(logFile, `docker build -t ${tag}\n`, { flag: 'a' });
  return new Promise((res, rej) => {
    const child = spawn('/bin/sh', ['-c', `"$0" build -t "$1" -f - "$2" >> "$3" 2>&1`, docker, tag, context, logFile], { stdio: ['pipe', 'ignore', 'ignore'] });
    child.once('error', rej);
    child.once('close', (code) => (code === 0 ? res() : rej(new Error(`docker build of ${tag} failed (exit ${code}); see ${logFile}`))));
    child.stdin.end(dockerfile);
  });
}

/** Docker refuses names with anything but these. */
export function containerName(sessionId: string): string {
  return `factory-${sessionId.slice(0, 8)}`;
}

/**
 * Starts a session's container and leaves it idle for `exec`. Privileged, with
 * a volume of its own for /var/lib/docker, so the Docker inside it can run the
 * repo's stack; `--init`, so the servers `start` leaves in the background are
 * reaped when they exit. The volume goes with the container. `envNames` are
 * passed from this process's environment by name, never on the command line.
 */
export async function startContainer(docker: string, image: string, sessionId: string, tickPid: number, envNames: string[], env: NodeJS.ProcessEnv): Promise<string> {
  const name = containerName(sessionId);
  await execFileAsync(docker, [
    'run', '-d', '--init', '--privileged', '-v', '/var/lib/docker',
    '--name', name, '--hostname', name,
    '--label', `${CONTAINER_LABEL}=${sessionId}`, '--label', `${TICK_LABEL}=${tickPid}`,
    ...envNames.flatMap((n) => ['-e', n]),
    image, 'sleep', 'infinity',
  ], { env });
  return name;
}

/** `docker exec` arguments for one command in a session's container. */
export function execArgs(name: string, user: string, cwd: string | null, envNames: string[], command: string[], stdin = false): string[] {
  return ['exec', ...(stdin ? ['-i'] : []), '-u', user, ...(cwd ? ['-w', cwd] : []), ...envNames.flatMap((n) => ['-e', n]), name, ...command];
}

/** Runs a command in the container and returns its stdout. */
export async function execIn(docker: string, name: string, user: string, cwd: string | null, command: string[], opts: { env?: NodeJS.ProcessEnv; envNames?: string[]; timeoutMs?: number } = {}): Promise<string> {
  const { stdout } = await execFileAsync(docker, execArgs(name, user, cwd, opts.envNames ?? [], command), {
    env: opts.env ?? process.env,
    maxBuffer: 16 * 1024 * 1024,
    ...(opts.timeoutMs ? { timeout: opts.timeoutMs, killSignal: 'SIGKILL' as const } : {}),
  });
  return stdout.trim();
}

/**
 * Runs the environment's `install`, then its `start`, in the clone, as Cursor
 * does when an agent's VM boots. Each writes to a log in the agent's home.
 * Returns what failed, for the agent to be told; an empty list when both ran.
 */
export async function bootEnvironment(docker: string, name: string, env: CursorEnvironment, workspace: string, procEnv: NodeJS.ProcessEnv): Promise<string[]> {
  const failed: string[] = [];
  const steps: [string, string | null, string, number][] = [['install', env.install, INSTALL_LOG, INSTALL_TIMEOUT_MS], ['start', env.start, START_LOG, START_TIMEOUT_MS]];
  for (const [step, command, log, timeoutMs] of steps) {
    if (!command) continue;
    const logPath = `${homeOf(env.user)}/${log}`;
    try {
      await execIn(docker, name, env.user, workspace, ['bash', '-c', 'bash -lc "$1" > "$2" 2>&1', '_', command, logPath], { env: procEnv, timeoutMs });
    } catch (err) {
      const e = err as { code?: number | string; killed?: boolean; signal?: string };
      failed.push(`the environment's \`${step}\` ${e.killed || e.signal ? `did not finish within ${timeoutMs / 60_000} minutes` : `exited ${e.code ?? 'abnormally'}`}; its output is in ~/${log}`);
    }
  }
  return failed;
}

export async function removeContainer(docker: string, name: string): Promise<void> {
  await execFileAsync(docker, ['rm', '-f', '-v', name]).catch(() => {});
}

/** Containers left by ticks that are no longer running. Returns how many went. */
export async function sweepContainers(docker: string): Promise<number> {
  let lines: string[];
  try {
    const { stdout } = await execFileAsync(docker, ['ps', '-a', '--filter', `label=${CONTAINER_LABEL}`, '--format', `{{.Names}}\t{{.Label "${TICK_LABEL}"}}`]);
    lines = stdout.split('\n').filter(Boolean);
  } catch {
    return 0;
  }
  const dead = lines.map((l) => l.split('\t')).filter(([, pid]) => !pid || !pidAlive(Number(pid))).map(([name]) => name!);
  for (const name of dead) await removeContainer(docker, name);
  return dead.length;
}
