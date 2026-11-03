// The machine the claude-code worker's agents share.
//
// A Cursor agent gets a VM of its own, thrown away when the agent ends. Here
// every session runs on one machine, and two things stand in for the VM:
//
//   - A run's leftovers end with it. Every process a session starts carries
//     FACTORY_SESSION in its environment; every container it starts carries a
//     `factory.session` label (the docker shim adds it) or belongs to its
//     compose project (COMPOSE_PROJECT_NAME is set per session). When a run
//     ends, the worker removes all of them. Before this, on Oct 24 2026, 29
//     containers and a dozen servers from runs up to ten days old held the
//     repo's ports and the Docker VM's memory, and agents reported a machine
//     too loaded to test on.
//   - One live slot. A repo's own stack usually fixes its container names and
//     ports, so two agents cannot both run it, and agents that tried spent
//     their runs writing override files or skipped the live test. An agent
//     takes the slot before it starts the stack and releases it after; while
//     it holds the slot, the stack runs as shipped. Implementation stays
//     parallel; only live stacks queue, and time spent waiting in that queue
//     is not charged to the run's budget.
//
// This is not a sandbox. Implementers run code the factory wrote, which is the
// same trust as before. Deps and security stay off this worker; a review runs
// in a container of its own (container.ts).

import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** The label the docker shim puts on what a session creates. */
export const SESSION_LABEL = 'factory.session';
/** How long `factory-slot take` waits before telling the agent to ask again:
 *  under the ten minutes a Claude Code shell command may run. */
export const TAKE_WAIT_MS = 9 * 60_000;
const TAKE_POLL_MS = 5_000;
/** A slot directory with no readable holder is a take caught mid-write; past
 *  this age it is a take that died there. */
const HALF_TAKEN_MS = 60_000;
const KILL_GRACE_MS = 5_000;

export interface MachinePaths {
  root: string;
  /** Prepended to every agent's PATH: `factory-slot` and the docker shim. */
  bin: string;
  /** Exists while someone holds the live slot; `holder.json` says who. */
  slot: string;
  /** One file per session: milliseconds spent waiting for the slot this run. */
  waits: string;
  /** One file per session with a run in flight, naming the tick that runs it. */
  sessions: string;
}

export function machinePaths(root: string): MachinePaths {
  return {
    root,
    bin: resolve(root, 'bin'),
    slot: resolve(root, 'slot'),
    waits: resolve(root, 'waits'),
    sessions: resolve(root, 'sessions'),
  };
}

/** A session as this module needs it. */
export interface SessionRef {
  id: string;
  workspace: string;
  /** The run's name, shown to an agent waiting on it. */
  name?: string;
}

export function composeProject(sessionId: string): string {
  return `factory-${sessionId.slice(0, 8)}`;
}

/** What a session's processes inherit, on top of the worker's own env. */
export function sessionEnv(paths: MachinePaths, session: SessionRef, path: string | undefined, tickPid: number): Record<string, string> {
  return {
    FACTORY_SESSION: session.id,
    FACTORY_WORKSPACE: session.workspace,
    FACTORY_RUN_NAME: session.name ?? '',
    FACTORY_TICK_PID: String(tickPid),
    FACTORY_MACHINE: paths.root,
    COMPOSE_PROJECT_NAME: composeProject(session.id),
    PATH: path ? `${paths.bin}:${path}` : paths.bin,
  };
}

const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * Writes `factory-slot`, and a `docker` that labels what a session creates and
 * otherwise is the real one. No shim when this machine has no docker.
 */
export function installBin(paths: MachinePaths, docker: string | null): void {
  for (const dir of [paths.bin, paths.waits, paths.sessions]) mkdirSync(dir, { recursive: true });
  const factoryRoot = fileURLToPath(new URL('..', import.meta.url));
  const tsx = resolve(factoryRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const write = (name: string, body: string) => {
    const file = resolve(paths.bin, name);
    writeFileSync(file, body);
    chmodSync(file, 0o755);
  };
  write('factory-slot', `#!/bin/sh
exec ${sq(process.execPath)} ${sq(tsx)} ${sq(resolve(factoryRoot, 'src', 'slotCli.ts'))} "$@"
`);
  const shim = resolve(paths.bin, 'docker');
  if (!docker) {
    rmSync(shim, { force: true });
    return;
  }
  write('docker', `#!/bin/sh
# The factory's docker: labels what a session creates so the worker can remove
# it when the run ends. Everything else goes to the real one untouched.
real=${sq(docker)}
[ -n "\${FACTORY_SESSION:-}" ] || exec "$real" "$@"
label="${SESSION_LABEL}=$FACTORY_SESSION"
case "$1" in
  run|create) c=$1; shift; exec "$real" "$c" --label "$label" "$@" ;;
  container|volume|network)
    case "\${2:-}" in
      run|create) g=$1; c=$2; shift 2; exec "$real" "$g" "$c" --label "$label" "$@" ;;
    esac ;;
esac
exec "$real" "$@"
`);
}

/** The real docker, or null where there is none. Never the shim, which
 *  would exec itself. launchd's PATH is near-empty, so the usual places too. */
export function findDocker(paths: MachinePaths): string | null {
  const dirs = [...(process.env['PATH'] ?? '').split(':'), '/usr/local/bin', '/opt/homebrew/bin', '/usr/bin'];
  for (const dir of dirs) {
    if (!dir || resolve(dir) === paths.bin) continue;
    const candidate = resolve(dir, 'docker');
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// ── the live slot ──────────────────────────────────────────────────────────

export interface Holder {
  session: string;
  workspace: string;
  name: string;
  /** The tick running the session; a dead tick's hold is void. */
  tickPid: number;
  since: number;
}

function holderFile(paths: MachinePaths): string {
  return resolve(paths.slot, 'holder.json');
}

export function readHolder(paths: MachinePaths): Holder | null {
  try {
    return JSON.parse(readFileSync(holderFile(paths), 'utf8')) as Holder;
  } catch {
    return null;
  }
}

/**
 * One attempt at the slot. `mkdir` is the lock: it either creates the
 * directory or finds it there, atomically. A hold whose tick is dead is broken
 * and the slot taken.
 */
export function tryTake(paths: MachinePaths, me: Holder): 'taken' | 'mine' | Holder | null {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(paths.slot);
      writeFileSync(holderFile(paths), JSON.stringify(me));
      return 'taken';
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    const holder = readHolder(paths);
    if (holder?.session === me.session) return 'mine';
    if (holder && pidAlive(holder.tickPid)) return holder;
    if (!holder) {
      let age = 0;
      try { age = Date.now() - statSync(paths.slot).mtimeMs; } catch { continue; }
      if (age < HALF_TAKEN_MS) return null;
    }
    rmSync(paths.slot, { recursive: true, force: true });
  }
  return null;
}

/** Frees the slot if this session holds it. */
export function releaseSlot(paths: MachinePaths, session: string): boolean {
  if (readHolder(paths)?.session !== session) return false;
  rmSync(paths.slot, { recursive: true, force: true });
  return true;
}

export function waitedMs(paths: MachinePaths, session: string): number {
  try {
    return Number(readFileSync(resolve(paths.waits, session), 'utf8')) || 0;
  } catch {
    return 0;
  }
}

export function addWait(paths: MachinePaths, session: string, ms: number): void {
  mkdirSync(paths.waits, { recursive: true });
  writeFileSync(resolve(paths.waits, session), String(waitedMs(paths, session) + Math.round(ms)));
}

export function resetWait(paths: MachinePaths, session: string): void {
  rmSync(resolve(paths.waits, session), { force: true });
}

// ── teardown ───────────────────────────────────────────────────────────────

interface Proc { pid: number; ppid: number; command: string; env: string }

/** This user's processes with their environments. */
async function listProcesses(): Promise<Proc[]> {
  if (process.platform === 'linux') {
    const procs: Proc[] = [];
    for (const entry of readdirSync('/proc')) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        const stat = readFileSync(`/proc/${entry}/stat`, 'utf8');
        const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
        const command = readFileSync(`/proc/${entry}/cmdline`, 'utf8').replace(/\0/g, ' ');
        const env = readFileSync(`/proc/${entry}/environ`, 'utf8').replace(/\0/g, ' ');
        procs.push({ pid: Number(entry), ppid, command, env });
      } catch { /* gone, or not ours */ }
    }
    return procs;
  }
  // BSD ps: -E appends each process's environment to its command.
  const { stdout } = await execFileAsync('ps', ['-E', '-ww', '-axo', 'pid=,ppid=,command='], { maxBuffer: 64 * 1024 * 1024 });
  return stdout.split('\n').flatMap((line) => {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    return m ? [{ pid: Number(m[1]), ppid: Number(m[2]), command: m[3]!, env: m[3]! }] : [];
  });
}

/** Pids listening on a TCP port; empty where lsof is missing. */
async function listeningPids(): Promise<Set<number>> {
  try {
    const { stdout } = await execFileAsync('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fp'], { maxBuffer: 16 * 1024 * 1024 });
    return new Set(stdout.split('\n').filter((l) => l.startsWith('p')).map((l) => Number(l.slice(1))));
  } catch (err) {
    // lsof exits 1 when nothing matches.
    const out = (err as { stdout?: string }).stdout ?? '';
    return new Set(out.split('\n').filter((l) => l.startsWith('p')).map((l) => Number(l.slice(1))));
  }
}

function ancestors(procs: Proc[], pid: number): Set<number> {
  const parent = new Map(procs.map((p) => [p.pid, p.ppid]));
  const chain = new Set<number>();
  for (let p: number | undefined = pid; p !== undefined && p > 1 && !chain.has(p); p = parent.get(p)) chain.add(p);
  return chain;
}

/**
 * Ends the session's processes. `listenersOnly` is for a release mid-turn:
 * the agent itself and its tools carry the marker too, so only servers go,
 * and never the process asking. An app the session launched into the system
 * (Docker Desktop, opened by an agent once) is not the session's to end.
 */
async function killSessionProcesses(session: string, listenersOnly: boolean): Promise<number> {
  const procs = await listProcesses();
  const marker = new RegExp(`(^|\\s)FACTORY_SESSION=${session}(\\s|$)`);
  const spared = ancestors(procs, process.pid);
  const listening = listenersOnly ? await listeningPids() : null;
  const targets = procs
    .filter((p) => marker.test(p.env) && !spared.has(p.pid) && !p.command.startsWith('/Applications/'))
    .filter((p) => !listening || listening.has(p.pid))
    .map((p) => p.pid);
  for (const pid of targets) { try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ } }
  const deadline = Date.now() + KILL_GRACE_MS;
  while (targets.some(pidAlive) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250));
  for (const pid of targets.filter(pidAlive)) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
  return targets.length;
}

async function dockerLines(docker: string, args: string[]): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(docker, args, { maxBuffer: 16 * 1024 * 1024 });
    return stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Removes the session's containers, their volumes, and its networks: those it
 * labelled, those in its compose project, and those compose started from its
 * workspace under any project name.
 */
async function removeSessionContainers(session: SessionRef, docker: string): Promise<number> {
  const label = `${SESSION_LABEL}=${session.id}`;
  const ids = new Set(await dockerLines(docker, ['ps', '-aq', '--filter', `label=${label}`]));
  const projects = new Set([composeProject(session.id)]);
  const all = await dockerLines(docker, ['ps', '-a', '--format', '{{.ID}}\t{{.Label "com.docker.compose.project"}}\t{{.Label "com.docker.compose.project.working_dir"}}']);
  for (const line of all) {
    const [id, project, dir] = line.split('\t');
    if (!id) continue;
    const fromWorkspace = !!dir && (dir === session.workspace || dir.startsWith(`${session.workspace}/`));
    if (fromWorkspace || (project && projects.has(project))) {
      ids.add(id);
      if (project) projects.add(project);
    }
  }
  for (const project of projects) {
    await dockerLines(docker, ['compose', '-p', project, 'down', '--volumes', '--remove-orphans', '--timeout', '5']);
  }
  const left = [...ids];
  if (left.length > 0) await dockerLines(docker, ['rm', '-f', '-v', ...left]);
  const volumes = await dockerLines(docker, ['volume', 'ls', '-q', '--filter', `label=${label}`]);
  if (volumes.length > 0) await dockerLines(docker, ['volume', 'rm', '-f', ...volumes]);
  const networks = await dockerLines(docker, ['network', 'ls', '-q', '--filter', `label=${label}`]);
  if (networks.length > 0) await dockerLines(docker, ['network', 'rm', ...networks]);
  return ids.size;
}

/**
 * What a session leaves on the machine, removed. At the end of a run that is
 * everything; on a release mid-turn it is the containers and the servers.
 */
export async function teardown(
  session: SessionRef,
  docker: string | null,
  opts: { listenersOnly?: boolean } = {},
): Promise<{ processes: number; containers: number }> {
  const processes = await killSessionProcesses(session.id, opts.listenersOnly ?? false).catch(() => 0);
  const containers = docker ? await removeSessionContainers(session, docker) : 0;
  return { processes, containers };
}

// ── sessions in flight ─────────────────────────────────────────────────────

export function recordSession(paths: MachinePaths, session: SessionRef, tickPid: number): void {
  mkdirSync(paths.sessions, { recursive: true });
  writeFileSync(resolve(paths.sessions, `${session.id}.json`), JSON.stringify({ ...session, tickPid }));
}

export function forgetSession(paths: MachinePaths, sessionId: string): void {
  rmSync(resolve(paths.sessions, `${sessionId}.json`), { force: true });
  resetWait(paths, sessionId);
}

/**
 * Cleans up after ticks that died with runs in flight: their agents were
 * killed with them, but not what those agents started. Also drops the
 * untagged images rebuilt stacks leave behind.
 */
export async function sweepDeadSessions(paths: MachinePaths, docker: string | null, log: (msg: string) => void): Promise<void> {
  let entries: string[] = [];
  try { entries = readdirSync(paths.sessions); } catch { /* none yet */ }
  for (const entry of entries) {
    let rec: SessionRef & { tickPid: number };
    try {
      rec = JSON.parse(readFileSync(resolve(paths.sessions, entry), 'utf8')) as SessionRef & { tickPid: number };
    } catch {
      rmSync(resolve(paths.sessions, entry), { force: true });
      continue;
    }
    if (pidAlive(rec.tickPid)) continue;
    const left = await teardown(rec, docker);
    releaseSlot(paths, rec.id);
    forgetSession(paths, rec.id);
    if (left.processes + left.containers > 0) {
      log(`removed what session ${rec.id} left when its tick died: ${left.processes} processes, ${left.containers} containers`);
    }
  }
  const holder = readHolder(paths);
  if (holder && !pidAlive(holder.tickPid)) releaseSlot(paths, holder.session);
  if (docker) await dockerLines(docker, ['image', 'prune', '-f']);
}
