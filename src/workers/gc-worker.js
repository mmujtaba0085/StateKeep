/**
 * src/workers/gc-worker.js
 *
 * Background process: runs every 60s.
 *   - Archives actors idle > 24h (compresses state to JSON file)
 *   - Calls apv_actor_stopped() and apv_vacate_prefix() on archived actors
 *
 * Managed by statekeep-gc-worker.service (systemd).
 */

import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { gzipSync } from 'zlib';

import { getDb } from '../registry/db.js';
import { startHeartbeat } from './heartbeat.js';
import { findIdleActors, updateActorStatus } from '../registry/actorRepo.js';
import { cancelAllPendingForActor } from '../registry/scheduledEventRepo.js';
import { getEngine, engineReady } from '../ffi/engine.js';
import { fingerprintToBigInt } from '../ffi/hashUtils.js';

const DATA_DIR         = process.env.STATEKEEP_DATA_DIR ?? '/opt/statekeep/data';
const ARCHIVE_DIR      = join(DATA_DIR, 'archives');
const IDLE_MS          = 24 * 60 * 60 * 1000;   // 24 hours
const BATCH_SIZE       = 500;
const INTERVAL_MS      = 60_000;
const VACUUM_INTERVAL  = parseInt(process.env.STATEKEEP_VACUUM_INTERVAL_HOURS ?? '24', 10) * 3_600_000;

let lastVacuumAt = 0;

console.log('[gc-worker] Starting...');
await engineReady;
getDb();
startHeartbeat('gc');
mkdirSync(ARCHIVE_DIR, { recursive: true });

async function runGC() {
  const eng    = getEngine();
  const actors = findIdleActors(IDLE_MS, BATCH_SIZE);

  if (actors.length === 0) return;

  console.log(`[gc-worker] Archiving ${actors.length} idle actors`);

  for (const actor of actors) {
    try {
      // Serialize state to compressed JSON
      const archiveData = {
        id:                 actor.id,
        orgId:              actor.orgId,
        definitionId:       actor.definitionId,
        stateValue:         actor.stateValue,
        context:            actor.context,
        historyFingerprint: actor.historyFingerprint,
        logicalStartTick:   actor.logicalStartTick,
        archivedAt:         Date.now(),
      };

      const filename = join(ARCHIVE_DIR, `${actor.orgId}_${actor.id}.json.gz`);
      writeFileSync(filename, gzipSync(JSON.stringify(archiveData)));

      // Cancel any pending scheduled events before archiving
      cancelAllPendingForActor(actor.id, actor.orgId);

      // Update DB status
      updateActorStatus(actor.id, 'archived');

      // Record archive metadata for lookup/restore
      try {
        getDb().prepare(`
          INSERT OR REPLACE INTO actor_archives
            (actor_id, org_id, machine_id, archived_at, file_path, state_value, definition_id)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          actor.id,
          actor.orgId,
          null,   // machine_id — skip JOIN cost in gc, set on restore if needed
          archiveData.archivedAt,
          filename,
          actor.stateValue ? JSON.stringify(actor.stateValue) : null,
          actor.definitionId,
        );
      } catch {}

      // Notify engine
      try {
        const tick        = eng.clockTick();
        const prefixHash  = fingerprintToBigInt(actor.historyFingerprint);
        eng.actorStopped(actor.logicalStartTick, prefixHash);
        eng.vacatePrefix(actor.logicalStartTick, prefixHash);
      } catch {}

    } catch (err) {
      console.error(`[gc-worker] Failed to archive actor ${actor.id}:`, err.message);
    }
  }

  console.log(`[gc-worker] Archived ${actors.length} actors`);

  // Prune terminal scheduled_events older than retention period
  const PRUNE_DAYS = parseInt(process.env.SCHEDULED_EVENT_RETENTION_DAYS ?? '30', 10);
  const cutoff     = Date.now() - (PRUNE_DAYS * 24 * 60 * 60 * 1000);
  const pruned     = getDb().prepare(`
    DELETE FROM scheduled_events
    WHERE status IN ('fired', 'failed', 'cancelled')
    AND created_at < ?
  `).run(cutoff).changes;

  if (pruned > 0) {
    console.log(`[gc-worker] Pruned ${pruned} terminal scheduled_events older than ${PRUNE_DAYS} days`);
  }

  // Periodic SQLite maintenance
  const now2 = Date.now();
  if (now2 - lastVacuumAt >= VACUUM_INTERVAL) {
    try {
      getDb().pragma('incremental_vacuum(1000)');
      getDb().pragma('optimize');
      lastVacuumAt = now2;
      console.log('[gc-worker] SQLite incremental_vacuum + optimize complete');
    } catch (err) {
      console.warn('[gc-worker] SQLite maintenance failed:', err.message);
    }
  }
}

async function gcLoop() {
  while (true) {
    try {
      await runGC();
    } catch (err) {
      console.error('[gc-worker] Error:', err);
    }
    await new Promise(r => setTimeout(r, INTERVAL_MS));
  }
}

gcLoop().catch(err => {
  console.error('[gc-worker] Fatal:', err);
  process.exit(1);
});
