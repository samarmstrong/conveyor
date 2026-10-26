import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { findDocker, installBin, machinePaths, pidAlive, releaseSlot, sessionEnv, teardown, tryTake, type Holder, type MachinePaths } from '../src/localMachine.ts';

let root: string;
let paths: MachinePaths;
beforeEach(() => {
  root = mkdtempSync(resolve(tmpdir(), 'factory-machine-'));
  paths = machinePaths(root);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const holder = (session: string, tickPid = process.pid): Holder => ({ session, workspace: `/ws/${session}`, name: `#1 ${session}`, tickPid, since: Date.now() });

/** A pid nothing is running as: a shell's, read after it exited and was reaped. */
function deadPid(): number {
  return Number(execFileSync('/bin/sh', ['-c', 'echo $$'], { encoding: 'utf8' }).trim());
}

describe('the live slot', () => {
  it('goes to one session at a time and is freed only by its holder', () => {
    expect(tryTake(paths, holder('a'))).toBe('taken');
    expect(tryTake(paths, holder('a'))).toBe('mine');
    expect(tryTake(paths, holder('b'))).toMatchObject({ session: 'a' });
    expect(releaseSlot(paths, 'b')).toBe(false);
    expect(releaseSlot(paths, 'a')).toBe(true);
    expect(tryTake(paths, holder('b'))).toBe('taken');
  });

  it('is taken over from a holder whose tick is dead', () => {
    expect(tryTake(paths, holder('a', deadPid()))).toBe('taken');
    expect(tryTake(paths, holder('b'))).toBe('taken');
  });

  it('waits out a take caught mid-write, and breaks one that died there', () => {
    mkdirSync(paths.slot);
    expect(tryTake(paths, holder('b'))).toBeNull();
    const old = new Date(Date.now() - 5 * 60_000);
    utimesSync(paths.slot, old, old);
    expect(tryTake(paths, holder('b'))).toBe('taken');
  });
});

describe('the docker shim', () => {
  let fake: string;
  beforeEach(() => {
    fake = resolve(root, 'real-docker');
    writeFileSync(fake, '#!/bin/sh\necho "$@"\n');
    chmodSync(fake, 0o755);
    installBin(paths, fake);
  });
  const run = (args: string[], session?: string) =>
    execFileSync(resolve(paths.bin, 'docker'), args, { env: { PATH: process.env['PATH'], ...(session ? { FACTORY_SESSION: session } : {}) }, encoding: 'utf8' }).trim();

  it('labels what a session creates', () => {
    expect(run(['run', '-d', '--name', 'pg', 'postgres:16'], 's1')).toBe('run --label factory.session=s1 -d --name pg postgres:16');
    expect(run(['container', 'create', 'redis'], 's1')).toBe('container create --label factory.session=s1 redis');
    expect(run(['volume', 'create', 'v'], 's1')).toBe('volume create --label factory.session=s1 v');
  });

  it('passes everything else, and everyone else, through untouched', () => {
    expect(run(['compose', 'up', '-d'], 's1')).toBe('compose up -d');
    expect(run(['ps', '-a'], 's1')).toBe('ps -a');
    expect(run(['run', 'x'])).toBe('run x');
  });

  it('is never mistaken for the real docker', () => {
    const before = process.env['PATH'];
    process.env['PATH'] = `${paths.bin}:${before}`;
    try {
      expect(findDocker(paths)).not.toBe(resolve(paths.bin, 'docker'));
    } finally {
      process.env['PATH'] = before;
    }
  });
});

describe('teardown', () => {
  const children: ChildProcess[] = [];
  afterEach(() => { for (const c of children) c.kill('SIGKILL'); });
  // node, not sleep: macOS hides the environment of its own platform binaries
  // from ps. Agents' servers (node, python, Chrome) are not those.
  const sleeper = (env: Record<string, string>) => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { env: { ...process.env, ...env }, detached: true, stdio: 'ignore' });
    children.push(child);
    return child.pid!;
  };

  it("ends the session's processes, however detached, and no one else's", async () => {
    const session = { id: `t-${process.pid}-${Date.now()}`, workspace: '/nowhere' };
    const mine = sleeper(sessionEnv(paths, session, process.env['PATH'], process.pid));
    const other = sleeper({ FACTORY_SESSION: `${session.id}-other` });
    const result = await teardown(session, null);
    expect(result.processes).toBe(1);
    expect(pidAlive(mine)).toBe(false);
    expect(pidAlive(other)).toBe(true);
  });

  it('on a release, ends only servers', async () => {
    const session = { id: `r-${process.pid}-${Date.now()}`, workspace: '/nowhere' };
    const tool = sleeper({ FACTORY_SESSION: session.id });
    await teardown(session, null, { listenersOnly: true });
    expect(pidAlive(tool)).toBe(true);
  });
});
