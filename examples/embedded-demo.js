/**
 * examples/embedded-demo.js
 *
 * Demonstrates StateKeep in embedded (in-process) mode — no HTTP server needed.
 * Run with: node --env-file=.env examples/embedded-demo.js
 */

import { createStateKeep } from '../src/lib/index.js';
import { randomBytes } from 'crypto';

// Simple 3-state traffic-light machine
const lightMachine = {
  id:      'traffic-light',
  initial: 'red',
  states: {
    red:    { on: { NEXT: 'green' } },
    green:  { on: { NEXT: 'yellow' } },
    yellow: { on: { NEXT: 'red' } },
  },
};

const N_ACTORS = 5;
const N_EVENTS = 10;

async function run() {
  console.log('[demo] Initialising StateKeep (embedded mode)...');

  const dbPath = process.env.STATEKEEP_DB_PATH ?? 'data/embedded-demo.db';
  const encKey = process.env.STATEKEEP_ENCRYPTION_KEY ?? randomBytes(32).toString('hex');

  const sk = await createStateKeep({ dbPath, encryptionKey: encKey });

  // Deploy the machine
  console.log('[demo] Deploying traffic-light machine...');
  const { id: definitionId } = await sk.deployDefinition(lightMachine);
  console.log(`[demo] Deployed: ${definitionId}`);

  // Spawn N actors
  console.log(`[demo] Spawning ${N_ACTORS} actors...`);
  const actors = await Promise.all(
    Array.from({ length: N_ACTORS }, () => sk.spawnActor({ definitionId }))
  );
  console.log(`[demo] Spawned ${actors.length} actors`);

  // Send events to all actors and time it
  const t0 = Date.now();
  let totalEvents = 0;
  for (let i = 0; i < N_EVENTS; i++) {
    await Promise.all(actors.map(a => sk.sendEvent(a.id, { type: 'NEXT' })));
    totalEvents += actors.length;
  }
  const elapsed = Date.now() - t0;

  console.log(`[demo] ${totalEvents} events in ${elapsed}ms → ${Math.round(totalEvents / (elapsed / 1000))} ev/s`);

  // Read final state of the first actor
  const finalActor = await sk.getActor(actors[0].id);
  console.log(`[demo] Actor[0] final state: ${JSON.stringify(finalActor?.stateValue)}`);

  // Terminate all actors
  await Promise.all(actors.map(a => sk.terminateActor(a.id)));
  console.log('[demo] All actors terminated');

  await sk.close();
  console.log('[demo] Done.');
}

run().catch(err => {
  console.error('[demo] Fatal:', err);
  process.exit(1);
});
