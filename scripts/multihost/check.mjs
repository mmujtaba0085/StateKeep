#!/usr/bin/env node
/**
 * scripts/multihost/check.mjs — cluster checks against servers on separate machines.
 *
 *   node scripts/multihost/check.mjs \
 *     --node A=http://10.0.0.11:3000 --node B=http://10.0.0.12:3000 --node C=http://10.0.0.13:3000 \
 *     --api-key <key> [--hook 'ssh {host} {cmd}'] [--rounds 3]
 *
 * Run it from any machine that reaches the servers (each started with
 * scripts/multihost/node.sh against ONE empty database). Checks, every round:
 *
 *   1. no lost updates: concurrent events for one actor through every server
 *   2. a deployment through any server routes the next event on every server
 *   3. after: timers fire on time whichever server created them
 *   4. (with --hook) a server frozen before its registry check routes with a deployment
 *      committed meanwhile
 *   5. (with --hook) a server frozen mid-event and taken over answers 503 OWNER_CHANGED and
 *      nothing is lost or overwritten
 *
 * --hook is how this script reaches a server's machine to arm a pause point: {host} is
 * the host of the server's URL, {cmd} a shell command (e.g. `ssh {host} {cmd}`; for a
 * local server use '{cmd}'). Hooks live in /tmp/sk-mh-hooks unless --hook-dir says else
 * ({name} in it is replaced by the server's name: several servers on one machine).
 * Exit code 0 when every check passed.
 */
const args = process.argv.slice(2);
const nodes = {};
let HOOK = null, HOOK_DIR = '/tmp/sk-mh-hooks', ROUNDS = 1, API_KEY = process.env.STATEKEEP_API_KEY ?? '';
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--node') { const [k, v] = args[++i].split('='); nodes[k] = v.replace(/\/$/, ''); }
  else if (a === '--hook') HOOK = args[++i];
  else if (a === '--hook-dir') HOOK_DIR = args[++i];
  else if (a === '--rounds') ROUNDS = Number(args[++i]);
  else if (a === '--api-key') API_KEY = args[++i];
  else { console.error(`unknown argument ${a}`); process.exit(2); }
}
const names = Object.keys(nodes);
if (names.length < 2) { console.error('give at least two --node NAME=URL'); process.exit(2); }

import { execSync } from 'node:child_process';
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const run = `${Date.now().toString(36)}`;
const call = async (n, method, path, body) => {
  const headers = { ...(API_KEY ? { 'x-api-key': API_KEY } : {}), ...(body ? { 'content-type': 'application/json' } : {}) };
  const r = await fetch(nodes[n] + path, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) });
  return { status: r.status, servedBy: r.headers.get('x-statekeep-served-by'), body: await r.json().catch(() => ({})) };
};
const toggle = (fam, extra = {}) => ({ id: fam, initial: 'a', states: { a: { on: { T: 'b' } }, b: { on: { T: 'a' } }, ...extra } });
const Ts = async (id) => (await call(names[0], 'GET', `/v1/actors/${id}/events?limit=100`)).body.events.filter((e) => (e.eventType ?? e.type) === 'T').length;
const deployV1 = async (fam) => { const r = await call(names[0], 'PUT', '/v1/definitions', { id: `${fam}-v1`, definition: toggle(fam) }); if (r.status !== 201) throw new Error(`v1: ${r.status} ${JSON.stringify(r.body)}`); };
const spawnOn = async (n, fam) => (await call(n, 'POST', '/v1/actors', { definitionId: `${fam}-v1` })).body.id;

function remote(n, cmd) {
  const host = new URL(nodes[n]).hostname;
  execSync(HOOK.replaceAll('{host}', host).replaceAll('{cmd}', cmd), { stdio: 'ignore' });
}
const hookPath = (n, p) => `${HOOK_DIR.replaceAll('{name}', n)}/${p}`;   // {name}: per-server dir (one machine)
async function freezeAt(n, point, start) {
  remote(n, `touch ${hookPath(n, point)}.arm`);
  const pending = start();
  for (let i = 0; i < 100; i++) {
    try { remote(n, `test -e ${hookPath(n, point)}.paused`); return { pending }; } catch {}
    await sleep(100);
  }
  throw new Error(`${n} did not reach ${point}`);
}
const release = (n, point) => remote(n, `touch ${hookPath(n, point)}.release`);

const results = [];
async function check(name, fn) {
  const t0 = Date.now();
  try { await fn(); results.push([name, 'ok']); console.log(`ok    ${name} (${Date.now() - t0} ms)`); }
  catch (e) { results.push([name, e.message]); console.log(`FAIL  ${name}: ${e.message}`); }
}
const must = (cond, msg) => { if (!cond) throw new Error(msg); };

for (let round = 1; round <= ROUNDS; round++) {
  const R = `${run}r${round}`;
  await check(`[${round}] no lost updates through every server`, async () => {
    const fam = `mh1${R}`; await deployV1(fam);
    for (const owner of names) {
      const id = await spawnOn(owner, fam);
      const rs = await Promise.all(Array.from({ length: 40 }, (_, i) => call(names[i % names.length], 'POST', `/v1/actors/${id}/event`, { type: 'T' })));
      must(rs.every((r) => r.status === 200), `event failed: ${JSON.stringify(rs.find((r) => r.status !== 200))}`);
      must(await Ts(id) === 40, `owner ${owner}: ${await Ts(id)} events, expected 40`);
      const st = (await call(names[names.length - 1], 'GET', `/v1/actors/${id}`)).body.stateValue;
      must(st === 'a', `owner ${owner}: state ${st}, expected a`);
    }
  });

  await check(`[${round}] a deployment through any server routes the next event everywhere`, async () => {
    for (const deployer of names) {
      const fam = `mh2${deployer}${R}`.toLowerCase(); await deployV1(fam);
      const ids = {};
      for (const o of names) { ids[o] = await spawnOn(o, fam); await call(o, 'POST', `/v1/actors/${ids[o]}/event`, { type: 'T' }); }
      const d = await call(deployer, 'PUT', '/v1/definitions', { id: `${fam}-v2`, parentId: `${fam}-v1`, historyPath: ['T'], definition: toggle(fam, { z: {} }) });
      must(d.status === 201, `deploy via ${deployer}: ${d.status} ${JSON.stringify(d.body)}`);
      for (const o of names) {
        const r = await call(o, 'POST', `/v1/actors/${ids[o]}/event`, { type: 'T' });
        must(r.status === 200, `event on ${o}: ${r.status}`);
        const def = (await call(names[0], 'GET', `/v1/actors/${ids[o]}`)).body.definitionId;
        must(def === `${fam}-v2`, `deployed via ${deployer}, owner ${o}: on ${def}`);
      }
    }
  });

  await check(`[${round}] after: timers fire on time whichever server created them`, async () => {
    const DELAY = 4000, fam = `mh3${R}`;
    const r = await call(names[0], 'PUT', '/v1/definitions', { id: `${fam}-v1`, definition: { id: fam, initial: 'wait', states: { wait: { after: { [DELAY]: 'done' } }, done: {} } } });
    must(r.status === 201, `deploy ${r.status}`);
    const t0 = performance.now(), ids = {}, fired = {};
    for (const n of names) ids[n] = await spawnOn(n, fam);
    while (performance.now() - t0 < DELAY + 10000 && Object.keys(fired).length < names.length) {
      for (const n of names) if (fired[n] == null && (await call(names[0], 'GET', `/v1/actors/${ids[n]}`)).body.stateValue === 'done') fired[n] = Math.round(performance.now() - t0);
      await sleep(100);
    }
    for (const n of names) {
      must(fired[n] != null, `timer created on ${n} never fired`);
      must(fired[n] >= DELAY - 1500 && fired[n] <= DELAY + 5000, `timer created on ${n} fired after ${fired[n]} ms (delay ${DELAY})`);
    }
  });

  if (HOOK) {
    await check(`[${round}] a frozen server routes with a deployment committed meanwhile`, async () => {
      for (const owner of names) {
        const deployer = names.find((n) => n !== owner);
        const fam = `mh4${owner}${R}`.toLowerCase(); await deployV1(fam);
        const id = await spawnOn(owner, fam);
        await call(owner, 'POST', `/v1/actors/${id}/event`, { type: 'T' });
        const { pending } = await freezeAt(owner, 'unit-before-registry-check', () => call(owner, 'POST', `/v1/actors/${id}/event`, { type: 'T' }));
        let d;
        try { d = await call(deployer, 'PUT', '/v1/definitions', { id: `${fam}-v2`, parentId: `${fam}-v1`, historyPath: ['T'], definition: toggle(fam, { z: {} }) }); await sleep(1500); }
        finally { release(owner, 'unit-before-registry-check'); }
        must(d.status === 201, `deploy ${d.status}`);
        must((await pending).status === 200, 'frozen event failed');
        const def = (await call(names[0], 'GET', `/v1/actors/${id}`)).body.definitionId;
        must(def === `${fam}-v2`, `owner ${owner}: on ${def}`);
        must(await Ts(id) === 2, `owner ${owner}: ${await Ts(id)} events, expected 2`);
      }
    });

    await check(`[${round}] a frozen server that was taken over cannot commit from its stale cache`, async () => {
      for (const owner of names) {
        const other = names.find((n) => n !== owner);
        const fam = `mh5${owner}${R}`.toLowerCase(); await deployV1(fam);
        const id = await spawnOn(owner, fam);
        await call(owner, 'POST', `/v1/actors/${id}/event`, { type: 'T' });
        const { pending } = await freezeAt(owner, 'unit-before-registry-check', () => call(owner, 'POST', `/v1/actors/${id}/event`, { type: 'T' }));
        const others = [];
        try {
          await sleep(Number(process.env.TTL_MS ?? 3000) + 1000);
          for (let k = 0; k < 3; k++) others.push(await call(other, 'POST', `/v1/actors/${id}/event`, { type: 'T' }));
        } finally { release(owner, 'unit-before-registry-check'); }
        const frozen = await pending;
        must(others.every((r) => r.status === 200), `events via ${other}: ${others.map((r) => r.status)}`);
        must(frozen.status === 503 && frozen.body.code === 'OWNER_CHANGED', `frozen ${owner} answered ${frozen.status} ${frozen.body.code ?? ''}`);
        await sleep(300);
        must(await Ts(id) === 4, `${await Ts(id)} events, expected 4`);
        const st = (await call(names[0], 'GET', `/v1/actors/${id}`)).body.stateValue;
        must(st === 'a', `state ${st}, expected a`);
      }
    });
  }
}

const failed = results.filter(([, r]) => r !== 'ok');
console.log(`\n${results.length - failed.length}/${results.length} checks passed across ${names.length} servers (${names.join(', ')})`);
process.exit(failed.length ? 1 : 0);
