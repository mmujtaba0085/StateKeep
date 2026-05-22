/**
 * test/e2e/claims.spec.js
 * Stage 6: Core APV migration claims — Q2, Q4, Q9, Q10, Q13, Q14, Q16, Q22.
 *
 * Engine-dependent tests (Q2, Q9, Q10, Q22) automatically skip in fallback mode.
 * Engine-agnostic tests (Q4, Q13, Q14, Q16) run in all environments.
 *
 * Run via WSL with STATEKEEP_ENGINE_PATH set so the real APV engine is active.
 *
 * Design note: tests deliberately avoid driving actors to final states so that
 * getActorState always returns definitionId (terminated actors omit it).
 */

import { test, expect } from '@playwright/test';
import { GET, POST, PUT, uniqueId, waitForActorMigration } from './helpers/api.js';

function expect2xx(res, label = '') {
  const ok = res.status >= 200 && res.status < 300;
  expect(ok, `${label}HTTP ${res.status}: ${JSON.stringify(res.body)}`).toBe(true);
}

// ── Q2: stateMapping maps actor to renamed state; definitionId advances to v2 ──

test('Q2: stateMapping maps actor to renamed state — definitionId advances to v2 after inline migration', async () => {
  const health = await GET('/v1/health');
  if (health.body?.engine !== 'real') { test.skip(); return; }

  const v1Id = uniqueId('q2-v1');
  const v2Id = uniqueId('q2-v2');

  const V1 = {
    id: 'q2', initial: 'idle',
    states: {
      idle:    { on: { WORK: 'working' } },
      working: { on: { PAUSE: 'paused', FINISH: 'done' } },
      paused:  { on: { RESUME: 'working' } },
      done:    { type: 'final' },
    },
  };
  // V2 renames 'working' → 'active'; stateMapping routes migrating actors
  const V2 = {
    id: 'q2', initial: 'idle',
    states: {
      idle:   { on: { WORK: 'active' } },
      active: { on: { PAUSE: 'paused', FINISH: 'done' } },
      paused: { on: { RESUME: 'active' } },
      done:   { type: 'final' },
    },
  };

  expect2xx(await PUT('/v1/definitions', { id: v1Id, definition: V1 }), 'v1: ');

  const r       = await POST('/v1/actors', { definitionId: v1Id });
  const actorId = r.body.id;
  expect2xx(await POST(`/v1/actors/${actorId}/event`, { type: 'WORK' }), 'WORK: ');

  expect2xx(await PUT('/v1/definitions', {
    id: v2Id, parentId: v1Id, definition: V2,
    stateMapping: { working: 'active' },
  }), 'v2 stateMapping: ');

  // PAUSE triggers inline migration: actor migrates to V2 via stateMapping (working→active),
  // then PAUSE applied → 'paused'.  Actor stays non-final so state reads return definitionId.
  const pauseRes = await POST(`/v1/actors/${actorId}/event`, { type: 'PAUSE' });
  expect2xx(pauseRes, 'PAUSE: ');
  expect(pauseRes.body.migratedTo).toBe(v2Id);

  // definitionId must update to v2Id confirming migration completed
  await waitForActorMigration(actorId, v2Id);

  const state = await GET(`/v1/actors/${actorId}/state`);
  expect(state.body.definitionId).toBe(v2Id);
  expect(state.body.stateValue).toBe('paused');
});

// ── Q4: Unknown event type is silently ignored ────────────────────────────────

test('Q4: unknown event type is silently ignored — stateValue unchanged, no error', async () => {
  const defId = uniqueId('q4-def');
  const def   = {
    id: 'q4', initial: 'idle',
    states: {
      idle:    { on: { START: 'running' } },
      running: { on: { STOP: 'done' } },
      done:    { type: 'final' },
    },
  };

  expect2xx(await PUT('/v1/definitions', { id: defId, definition: def }), 'def: ');

  const r       = await POST('/v1/actors', { definitionId: defId });
  const actorId = r.body.id;
  expect2xx(await POST(`/v1/actors/${actorId}/event`, { type: 'START' }), 'START: ');

  // Send an event with no matching transition in 'running'
  const res = await POST(`/v1/actors/${actorId}/event`, { type: 'UNKNOWN_EVENT_XYZ' });
  expect2xx(res, 'unknown event: ');

  // State must be unchanged
  const state = await GET(`/v1/actors/${actorId}/state`);
  expect(state.body.stateValue).toBe('running');
});

// ── Q9: Multi-event historyPath selects only actors with the exact fingerprint path ─

test('Q9: multi-event historyPath targets only actors whose fingerprint matches the full sequence', async () => {
  const health = await GET('/v1/health');
  if (health.body?.engine !== 'real') { test.skip(); return; }

  const v1Id = uniqueId('q9-v1');
  const v2Id = uniqueId('q9-v2');

  const V1 = {
    id: 'q9', initial: 'idle',
    states: {
      idle:       { on: { APPROVE: 'approved' } },
      approved:   { on: { PROCESS: 'processing', CANCEL: 'idle' } },
      processing: { on: { DONE: 'idle', EXPEDITE: 'idle' } },
    },
  };
  // V2 only targets actors that followed [APPROVE, PROCESS] exactly.
  // historyPath = ['APPROVE', 'PROCESS'] → prefix_hash = hash(APPROVE+PROCESS).
  // Actors that only sent [APPROVE] (fingerprint = hash(APPROVE)) are NOT eligible.
  const V2 = {
    id: 'q9', initial: 'idle',
    states: {
      idle:       { on: { APPROVE: 'approved' } },
      approved:   { on: { PROCESS: 'processing', CANCEL: 'idle' } },
      processing: { on: { DONE: 'idle', EXPEDITE: 'idle', RUSH: 'idle' } },
    },
  };

  expect2xx(await PUT('/v1/definitions', { id: v1Id, definition: V1 }), 'v1: ');

  // Actor A: follows [APPROVE, PROCESS] — fingerprint = hash(APPROVE+PROCESS)
  const rA       = await POST('/v1/actors', { definitionId: v1Id });
  const actorIdA = rA.body.id;
  expect2xx(await POST(`/v1/actors/${actorIdA}/event`, { type: 'APPROVE' }),  'A:APPROVE: ');
  expect2xx(await POST(`/v1/actors/${actorIdA}/event`, { type: 'PROCESS' }), 'A:PROCESS: ');

  // Actor B: follows [APPROVE] only — fingerprint = hash(APPROVE); NOT at hash(APPROVE+PROCESS)
  const rB       = await POST('/v1/actors', { definitionId: v1Id });
  const actorIdB = rB.body.id;
  expect2xx(await POST(`/v1/actors/${actorIdB}/event`, { type: 'APPROVE' }),  'B:APPROVE: ');

  // Deploy V2 with historyPath=['APPROVE','PROCESS'] — only Actor A's fingerprint matches
  const deployRes = await PUT('/v1/definitions', {
    id: v2Id, parentId: v1Id, definition: V2,
    historyPath: ['APPROVE', 'PROCESS'],
  });
  expect2xx(deployRes, 'v2 historyPath: ');
  // Exactly 1 actor enrolled (A), not 2 — B's fingerprint is hash(APPROVE) which doesn't match
  expect(deployRes.body.affectedActors).toBe(1);

  // RUSH is V2-only in 'processing' — proves Actor A migrated inline
  const rushRes = await POST(`/v1/actors/${actorIdA}/event`, { type: 'RUSH' });
  expect2xx(rushRes, 'A:RUSH: ');
  expect(rushRes.body.migratedTo).toBe(v2Id);

  await waitForActorMigration(actorIdA, v2Id);
  const stateA = await GET(`/v1/actors/${actorIdA}/state`);
  expect(stateA.body.definitionId).toBe(v2Id);

  // Actor B sends PROCESS (valid on V1) — no migration because fingerprint doesn't match
  const procRes = await POST(`/v1/actors/${actorIdB}/event`, { type: 'PROCESS' });
  expect2xx(procRes, 'B:PROCESS: ');
  expect(procRes.body.migratedTo).toBeNull();

  const stateB = await GET(`/v1/actors/${actorIdB}/state`);
  expect(stateB.body.definitionId).toBe(v1Id);
});

// ── Q10: Actor is not left in 'migrating' status after inline migration ────────

test('Q10: actor status is not migrating after inline migration completes', async () => {
  const health = await GET('/v1/health');
  if (health.body?.engine !== 'real') { test.skip(); return; }

  const v1Id = uniqueId('q10-v1');
  const v2Id = uniqueId('q10-v2');

  // V1 does not have PAUSE from running; V2 adds it.
  // Sending PAUSE proves inline migration ran (V1 would silently ignore it).
  const V1 = {
    id: 'q10', initial: 'idle',
    states: {
      idle:    { on: { GO: 'running' } },
      running: { on: { STOP: 'done' } },
      done:    { type: 'final' },
    },
  };
  const V2 = {
    id: 'q10', initial: 'idle',
    states: {
      idle:    { on: { GO: 'running' } },
      running: { on: { STOP: 'done', PAUSE: 'paused' } },
      paused:  { on: { RESUME: 'running' } },
      done:    { type: 'final' },
    },
  };

  expect2xx(await PUT('/v1/definitions', { id: v1Id, definition: V1 }), 'v1: ');

  // Spawn actor and send events BEFORE deploying V2 so logicalStartTick < V2.deployedAt
  const r       = await POST('/v1/actors', { definitionId: v1Id });
  const actorId = r.body.id;
  expect2xx(await POST(`/v1/actors/${actorId}/event`, { type: 'GO' }), 'GO: ');

  expect2xx(await PUT('/v1/definitions', { id: v2Id, parentId: v1Id, definition: V2 }), 'v2: ');

  // PAUSE is V2-only: triggers inline migration (V1→V2 same-name 'running') then PAUSE → 'paused'
  const pauseRes = await POST(`/v1/actors/${actorId}/event`, { type: 'PAUSE' });
  expect2xx(pauseRes, 'PAUSE: ');
  // migratedTo in event response confirms inline migration was atomic — no 'migrating' limbo
  expect(pauseRes.body.migratedTo).toBe(v2Id);
  expect(pauseRes.body.stateValue).toBe('paused');

  // State check immediately after: must not be left in 'migrating'
  const state = await GET(`/v1/actors/${actorId}/state`);
  expect(state.body.status).not.toBe('migrating');
  expect(state.body.definitionId).toBe(v2Id);
  expect(state.body.status).toBe('active');
});

// ── Q13: No rollback endpoint exists — returns 404 ────────────────────────────

test('Q13: POST /v1/definitions/:id/rollback returns 404 (no rollback endpoint)', async () => {
  const defId = uniqueId('q13-def');
  const def   = {
    id: 'q13', initial: 'idle',
    states: { idle: { on: { GO: 'done' } }, done: { type: 'final' } },
  };

  expect2xx(await PUT('/v1/definitions', { id: defId, definition: def }), 'deploy: ');

  const { status } = await POST(`/v1/definitions/${defId}/rollback`, {});
  expect(status).toBe(404);
});

// ── Q14: Export returns decrypted actor context (not an encrypted blob) ────────

test('Q14: GET /v1/actors/:id/export returns the actor context decrypted', async () => {
  const defId = uniqueId('q14-def');
  const def   = {
    id: 'q14', initial: 'active',
    states: {
      active: { on: { NEXT: 'done' } },
      done:   { type: 'final' },
    },
  };

  expect2xx(await PUT('/v1/definitions', { id: defId, definition: def }), 'def: ');

  const spawnRes = await POST('/v1/actors', {
    definitionId:   defId,
    initialContext: { secret: 'plan-xyz', amount: 1000, nested: { key: 'value' } },
  });
  expect(spawnRes.status).toBe(201);
  const actorId = spawnRes.body.id;

  const exportRes = await GET(`/v1/actors/${actorId}/export`);
  expect(exportRes.status).toBe(200);

  // Context must be the original plain object, not a binary or hex blob
  const ctx = exportRes.body.actor?.context;
  expect(ctx).not.toBeNull();
  expect(typeof ctx).toBe('object');
  expect(ctx.secret).toBe('plan-xyz');
  expect(ctx.amount).toBe(1000);
  expect(ctx.nested?.key).toBe('value');
});

// ── Q16: historyFingerprint is identical across 3 concurrent reads ─────────────

test('Q16: historyFingerprint is stable across 3 concurrent GET /state reads', async () => {
  const defId = uniqueId('q16-def');
  const def   = {
    id: 'q16', initial: 'a',
    states: {
      a: { on: { X: 'b' } },
      b: { on: { X: 'c' } },
      c: { on: { X: 'b' } },   // non-final: stay reachable
    },
  };

  expect2xx(await PUT('/v1/definitions', { id: defId, definition: def }), 'def: ');

  const r       = await POST('/v1/actors', { definitionId: defId });
  const actorId = r.body.id;
  expect2xx(await POST(`/v1/actors/${actorId}/event`, { type: 'X' }), 'X1: ');
  expect2xx(await POST(`/v1/actors/${actorId}/event`, { type: 'X' }), 'X2: ');
  // Actor now in state 'c' with a 16-char hex fingerprint

  // 3 concurrent reads — fingerprint must be identical across all
  const [s1, s2, s3] = await Promise.all([
    GET(`/v1/actors/${actorId}/state`),
    GET(`/v1/actors/${actorId}/state`),
    GET(`/v1/actors/${actorId}/state`),
  ]);

  const fp1 = s1.body.historyFingerprint;
  const fp2 = s2.body.historyFingerprint;
  const fp3 = s3.body.historyFingerprint;

  expect(fp1).toMatch(/^[0-9a-f]{16}$/);
  expect(fp2).toBe(fp1);
  expect(fp3).toBe(fp1);
});

// ── Q22: Migration decisions logged in migration_decisions and queryable ────────

test('Q22: inline migration decision is logged and queryable via GET /v1/actors/:id/decisions', async () => {
  const health = await GET('/v1/health');
  if (health.body?.engine !== 'real') { test.skip(); return; }

  const v1Id = uniqueId('q22-v1');
  const v2Id = uniqueId('q22-v2');

  // V2 adds CANCEL from running → idle (V1 does not have CANCEL, proving migration ran)
  const V1 = {
    id: 'q22', initial: 'idle',
    states: {
      idle:    { on: { GO: 'running' } },
      running: { on: { STOP: 'done' } },
      done:    { type: 'final' },
    },
  };
  const V2 = {
    id: 'q22', initial: 'idle',
    states: {
      idle:    { on: { GO: 'running' } },
      running: { on: { STOP: 'done', CANCEL: 'idle' } },
      done:    { type: 'final' },
    },
  };

  expect2xx(await PUT('/v1/definitions', { id: v1Id, definition: V1 }), 'v1: ');

  // Spawn actor and send events BEFORE deploying V2 so logicalStartTick < V2.deployedAt
  const r       = await POST('/v1/actors', { definitionId: v1Id });
  const actorId = r.body.id;
  expect2xx(await POST(`/v1/actors/${actorId}/event`, { type: 'GO' }), 'GO: ');

  expect2xx(await PUT('/v1/definitions', { id: v2Id, parentId: v1Id, definition: V2 }), 'v2: ');

  // CANCEL is V2-only: triggers inline migration (V1→V2) then CANCEL → 'idle' (non-final)
  const cancelRes = await POST(`/v1/actors/${actorId}/event`, { type: 'CANCEL' });
  expect2xx(cancelRes, 'CANCEL: ');
  expect(cancelRes.body.migratedTo).toBe(v2Id);

  // Wait for definitionId to confirm migration (actor is non-final → state returns definitionId)
  await waitForActorMigration(actorId, v2Id);

  // Decisions must be queryable via dedicated endpoint
  const decisionsRes = await GET(`/v1/actors/${actorId}/decisions`);
  expect(decisionsRes.status).toBe(200);
  expect(Array.isArray(decisionsRes.body.decisions)).toBe(true);
  expect(decisionsRes.body.decisions.length).toBeGreaterThan(0);

  const migrated = decisionsRes.body.decisions.find(d => d.decision === 'migrated');
  expect(migrated).toBeDefined();
  expect(migrated.fromDefinitionId).toBe(v1Id);
  expect(migrated.toDefinitionId).toBe(v2Id);
  expect(migrated.trigger).toBe('inline_event');
});
