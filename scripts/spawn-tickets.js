/**
 * scripts/spawn-tickets.js
 *
 * Spawns 20 support ticket actors and distributes them across states.
 * Run after deploying ticket-v1.
 *
 * Usage:
 *   SK_API_KEY=sk_live_... node scripts/spawn-tickets.js
 *   # or with an .env file:
 *   node --env-file=.env scripts/spawn-tickets.js
 *
 * Environment:
 *   SK_API_KEY   — your StateKeep API key (required)
 *   SK_BASE_URL  — override base URL (default: https://statekeep.161-97-163-210.nip.io)
 */

const API_KEY  = process.env.SK_API_KEY || process.env.STATEKEEP_API_KEY;
const BASE_URL = (process.env.SK_BASE_URL || 'https://statekeep.161-97-163-210.nip.io').replace(/\/$/, '');

if (!API_KEY) {
  console.error('Error: SK_API_KEY environment variable is required.');
  console.error('  SK_API_KEY=sk_live_... node scripts/spawn-tickets.js');
  process.exit(1);
}

const HEADERS = {
  'x-api-key':    API_KEY,
  'Content-Type': 'application/json',
};

async function api(method, path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: HEADERS,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw Object.assign(new Error(data.error || 'API error'), { status: res.status, data });
  return data;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Realistic ticket metadata
const TITLES = [
  'Login page not loading',
  'Payment fails at checkout',
  'Email not received after signup',
  'App crashes on iOS 17',
  'Dashboard shows wrong data',
  'Cannot export to CSV',
  'Webhook not firing',
  'API rate limit too low',
  'Two-factor auth locked out',
  'Profile picture upload fails',
  'Slow query on reports page',
  'Search returns no results',
  'Notification emails going to spam',
  'Dark mode broken on Safari',
  'Billing invoice has wrong amount',
  'SSO login loop',
  'Data missing after migration',
  'Webhook payload malformed',
  'Password reset link expired',
  'Mobile app freezes on startup',
];

const AGENTS = ['alice', 'bob', 'carol', 'dave', 'eve'];
const PRIORITIES = ['low', 'medium', 'high', 'critical'];

async function spawnActor(i) {
  const title    = TITLES[i % TITLES.length];
  const priority = PRIORITIES[Math.floor(Math.random() * PRIORITIES.length)];
  const actor = await api('POST', '/v1/actors', {
    definitionId:   'ticket-v1',
    initialContext: {
      ticketId:  `T-${String(i + 1).padStart(3, '0')}`,
      title,
      priority,
      reporter:  `user_${String(Math.floor(Math.random() * 900) + 100)}`,
      createdAt: new Date().toISOString(),
    },
  });
  return actor;
}

async function sendEvent(actorId, type, payload = {}) {
  try {
    return await api('POST', `/v1/actors/${actorId}/event`, { type, payload });
  } catch (err) {
    if (err.status === 409) return null; // needs_rescue, skip
    throw err;
  }
}

async function main() {
  console.log(`\nStateKeep Ticket Simulation`);
  console.log(`Base URL:  ${BASE_URL}`);
  console.log(`Spawning 20 ticket actors on ticket-v1...\n`);

  const actors = [];

  for (let i = 0; i < 20; i++) {
    const actor = await spawnActor(i);
    actors.push(actor);
    console.log(`[${String(i + 1).padStart(2)}] Spawned  ${actor.id}  state=open  "${TITLES[i % TITLES.length]}"`);
    await sleep(150);
  }

  console.log('\n--- Moving actors through states ---\n');

  // Group actors into cohorts based on how far they progress
  // Cohort A (actors 0-4): stay in `open`
  // Cohort B (actors 5-9): go to `assigned`
  // Cohort C (actors 10-17): go to `assigned` then `in_progress`
  // Cohort D (actors 18-19): go all the way to `resolved`

  // Cohort B — assign
  for (let i = 5; i <= 9; i++) {
    const a     = actors[i];
    const agent = AGENTS[i % AGENTS.length];
    const res   = await sendEvent(a.id, 'ASSIGN', { assignedTo: agent, assignedAt: new Date().toISOString() });
    if (res) console.log(`[${String(i + 1).padStart(2)}] ASSIGN   ${a.id}  state=${res.stateValue}  → agent: ${agent}`);
    await sleep(120);
  }

  // Cohort C — assign then start
  for (let i = 10; i <= 17; i++) {
    const a     = actors[i];
    const agent = AGENTS[i % AGENTS.length];
    const res1  = await sendEvent(a.id, 'ASSIGN', { assignedTo: agent, assignedAt: new Date().toISOString() });
    if (res1) console.log(`[${String(i + 1).padStart(2)}] ASSIGN   ${a.id}  state=${res1.stateValue}  → agent: ${agent}`);
    await sleep(100);
    const res2 = await sendEvent(a.id, 'START', { startedAt: new Date().toISOString() });
    if (res2) console.log(`[${String(i + 1).padStart(2)}] START    ${a.id}  state=${res2.stateValue}`);
    await sleep(120);
  }

  // Cohort D — full flow to resolved
  for (let i = 18; i <= 19; i++) {
    const a     = actors[i];
    const agent = AGENTS[i % AGENTS.length];
    const res1  = await sendEvent(a.id, 'ASSIGN', { assignedTo: agent });
    if (res1) console.log(`[${String(i + 1).padStart(2)}] ASSIGN   ${a.id}  state=${res1.stateValue}`);
    await sleep(100);
    const res2 = await sendEvent(a.id, 'START', {});
    if (res2) console.log(`[${String(i + 1).padStart(2)}] START    ${a.id}  state=${res2.stateValue}`);
    await sleep(100);
    const res3 = await sendEvent(a.id, 'RESOLVE', { resolvedBy: agent, resolution: 'fixed in v2.3.1' });
    if (res3) console.log(`[${String(i + 1).padStart(2)}] RESOLVE  ${a.id}  state=${res3.stateValue}  ✓ done`);
    await sleep(120);
  }

  console.log('\n--- Final state distribution ---\n');
  console.log('  open         : actors 1-5   (5 actors)');
  console.log('  assigned     : actors 6-10  (5 actors)');
  console.log('  in_progress  : actors 11-18 (8 actors)  ← will be stranded in ticket-v3');
  console.log('  resolved     : actors 19-20 (2 actors)  ← final state, not migrated');

  console.log('\n--- Actor IDs by state (for dashboard reference) ---\n');
  const byState = {};
  for (const a of actors) {
    const res = await api('GET', `/v1/actors/${a.id}/state`);
    const s   = res.stateValue;
    if (!byState[s]) byState[s] = [];
    byState[s].push(a.id);
  }
  for (const [state, ids] of Object.entries(byState)) {
    console.log(`  ${state.padEnd(15)} (${ids.length}): ${ids[0]}${ids.length > 1 ? ` ... +${ids.length - 1} more` : ''}`);
  }

  console.log('\nDone. Open the dashboard to see all actors:');
  console.log(`  ${BASE_URL}/dashboard/\n`);
}

main().catch(err => {
  console.error('\nFatal error:', err.message);
  if (err.data) console.error('API response:', JSON.stringify(err.data, null, 2));
  process.exit(1);
});
