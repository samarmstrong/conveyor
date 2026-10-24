// `factory-slot`: the live slot, as an agent of the claude-code worker sees it.
// The worker puts it on the agent's PATH and the session's identity in its
// environment; see localMachine.ts for what the slot is for.
//
//   factory-slot take      wait for the slot (up to 9 minutes a call) and hold it
//   factory-slot release   stop your containers and servers and free the slot
//   factory-slot status    who holds it

import { addWait, findDocker, machinePaths, readHolder, releaseSlot, teardown, TAKE_WAIT_MS, tryTake, type Holder } from './localMachine.ts';

const env = (name: string): string => {
  const value = process.env[name];
  if (!value) {
    console.error(`factory-slot: ${name} is not set; this command only works inside a factory session.`);
    process.exit(2);
  }
  return value;
};

const paths = machinePaths(env('FACTORY_MACHINE'));
const me: Holder = {
  session: env('FACTORY_SESSION'),
  workspace: env('FACTORY_WORKSPACE'),
  name: process.env['FACTORY_RUN_NAME'] || 'another factory agent',
  tickPid: Number(env('FACTORY_TICK_PID')),
  since: Date.now(),
};

const describe = (h: Holder) => `${h.name}, for ${Math.max(1, Math.round((Date.now() - h.since) / 60_000))} min`;

async function take(): Promise<number> {
  const started = Date.now();
  let announced = false;
  for (;;) {
    const result = tryTake(paths, me);
    if (result === 'taken' || result === 'mine') {
      addWait(paths, me.session, Date.now() - started);
      console.log(`You hold the live slot. The repo's stack and dev servers are yours to run as shipped: its own compose file, container names and ports. Run \`factory-slot release\` once your live checks are done; that stops the containers and servers you started.`);
      return 0;
    }
    if (result && !announced) {
      console.log(`Waiting for the live slot, held by ${describe(result)}...`);
      announced = true;
    }
    if (Date.now() - started >= TAKE_WAIT_MS) {
      addWait(paths, me.session, Date.now() - started);
      const holder = readHolder(paths);
      console.log(`The live slot is still held${holder ? ` by ${describe(holder)}` : ''}. Run \`factory-slot take\` again, or do other work first and come back. Time spent waiting here is not charged to your budget.`);
      return 75;
    }
    await new Promise((r) => setTimeout(r, 5_000));
  }
}

async function release(): Promise<number> {
  const docker = findDocker(paths);
  const removed = await teardown({ id: me.session, workspace: me.workspace }, docker, { listenersOnly: true });
  const held = releaseSlot(paths, me.session);
  console.log(`${held ? 'Released the live slot.' : 'You did not hold the live slot.'} Stopped ${removed.containers} containers and ${removed.processes} servers you started.`);
  return 0;
}

function status(): number {
  const holder = readHolder(paths);
  if (!holder) console.log('The live slot is free.');
  else if (holder.session === me.session) console.log('You hold the live slot.');
  else console.log(`The live slot is held by ${describe(holder)}.`);
  return 0;
}

const command = process.argv[2];
const code = command === 'take' ? await take()
  : command === 'release' ? await release()
  : command === 'status' ? status()
  : (console.error('usage: factory-slot take | release | status'), 2);
process.exit(code);
