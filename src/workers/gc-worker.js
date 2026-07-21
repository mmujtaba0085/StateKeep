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
import { join, dirname } from 'path';
import { gzipSync } from 'zlib';

import { getDb, isPostgres } from '../registry/db.js';
import { startHeartbeat } from './heartbeat.js';
import { findIdleActors, updateActorStatus } from '../registry/actorRepo.js';
import { cancelAllPendingForActor } from '../registry/scheduledEventRepo.js';
import { getEngine, engineReady } from '../ffi/engine.js';
import { fingerprintToBigInt } from '../ffi/hashUtils.js';

const DB_PATH          = process.env.STATEKEEP_DB_PATH ?? 'data/statekeep.db';
const DATA_DIR         = process.env.STATEKEEP_DATA_DIR ?? dirname(DB_PATH);
const ARCHIVE_DIR      = join(DATA_DIR, 'archives');
const IDLE_MS          = 24 * 60 * 60 * 1000;
const BATCH_SIZE       = 500;
const INTERVAL_MS      = 60_000;
const VACUUM_INTERVAL  = parseInt(process.env.STATEKEEP_VACUUM_INTERVAL_HOURS ?? '24', 10) * 3_600_000;

let lastVacuumAt = 0;

console.log('[gc-worker] Starting...');
await engineReady;

if (isPostgres) {
  const { bootstrapSchema } = await import('../registry/db-postgres.js');
  await bootstrapSchema();
} else {
  getDb();
}

startHeartbeat('gc');
mkdirSync(ARCHIVE_DIR, { recursive: true });

async function runGC() {
  const eng    = getEngine();
  const actors = await findIdleActors(IDLE_MS, BATCH_SIZE);

  if (actors.length === 0) return;

  console.log(`[gc-worker] Archiving ${actors.length} idle actors`);

  for (const actor of actors) {
    try {
      const archiveData = {
        id:                 actor.id,
        definitionId:       actor.definitionId,
        stateValue:         actor.stateValue,
        context:            actor.context,
        historyFingerprint: actor.historyFingerprint,
        logicalStartTick:   actor.logicalStartTick,
        archivedAt:         Date.now(),
      };

      const filename = join(ARCHIVE_DIR, `${actor.id}.json.gz`);
      writeFileSync(filename, gzipSync(JSON.stringify(archiveData)));

      await cancelAllPendingForActor(actor.id);
      await updateActorStatus(actor.id, 'archived');

      // Record archive metadata for lookup/restore
      try {
        if (isPostgres) {
          const { query } = await import('../registry/db-postgres.js');
          await query(
            `INSERT INTO actor_archives (actor_id, machine_id, archived_at, file_path, state_value, definition_id)
             VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (actor_id) DO UPDATE SET archived_at=EXCLUDED.archived_at, file_path=EXCLUDED.file_path, state_value=EXCLUDED.state_value`,
            [actor.id, null, archiveData.archivedAt, filename,
             actor.stateValue ? JSON.stringify(actor.stateValue) : null, actor.definitionId]
          );
        } else {
          getDb().prepare(`
            INSERT OR REPLACE INTO actor_archives
              (actor_id, machine_id, archived_at, file_path, state_value, definition_id)
            VALUES (?, ?, ?, ?, ?, ?)
          `).run(
            actor.id, null, archiveData.archivedAt, filename,
            actor.stateValue ? JSON.stringify(actor.stateValue) : null, actor.definitionId
          );
        }
      } catch {}

      // Notify engine
      try {
        const prefixHash = fingerprintToBigInt(actor.historyFingerprint);
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

  try {
    if (isPostgres) {
      const { query } = await import('../registry/db-postgres.js');
      const r = await query(
        `DELETE FROM scheduled_events WHERE status IN ('fired','failed','cancelled') AND created_at<$1`,
        [cutoff]
      );
      if (r.rowCount > 0) console.log(`[gc-worker] Pruned ${r.rowCount} terminal scheduled_events`);
    } else {
      const pruned = getDb().prepare(`
        DELETE FROM scheduled_events
        WHERE status IN ('fired', 'failed', 'cancelled') AND created_at < ?
      `).run(cutoff).changes;
      if (pruned > 0) console.log(`[gc-worker] Pruned ${pruned} terminal scheduled_events older than ${PRUNE_DAYS} days`);
    }
  } catch {}

  // Event pruning for active actors (opt-in via STATEKEEP_MAX_EVENT_HISTORY_DAYS)
  const MAX_HISTORY_DAYS = parseInt(process.env.STATEKEEP_MAX_EVENT_HISTORY_DAYS ?? '0', 10);
  if (MAX_HISTORY_DAYS > 0) {
    const cutoffMs = Date.now() - (MAX_HISTORY_DAYS * 24 * 60 * 60 * 1000);
    const PROTECTED = ['SPAWN','MIGRATED','MIGRATION_FAILED','SCHEDULED_EVENT_FIRED',
                       'SCHEDULED_EVENT_FAILED','MANUALLY_RESCUED'];
    try {
      if (isPostgres) {
        const { query } = await import('../registry/db-postgres.js');
        const placeholders = PROTECTED.map((_, i) => `$${i + 2}`).join(',');
        const r = await query(
          `DELETE FROM events WHERE processed_at<$1 AND event_type NOT IN (${placeholders})`,
          [cutoffMs, ...PROTECTED]
        );
        if (r.rowCount > 0) console.log(`[gc-worker] Pruned ${r.rowCount} user events older than ${MAX_HISTORY_DAYS} days`);
      } else {
        const placeholders = PROTECTED.map(() => '?').join(',');
        const pruned = getDb().prepare(
          `DELETE FROM events WHERE processed_at < ? AND event_type NOT IN (${placeholders})`
        ).run(cutoffMs, ...PROTECTED).changes;
        if (pruned > 0) console.log(`[gc-worker] Pruned ${pruned} user events older than ${MAX_HISTORY_DAYS} days`);
      }
    } catch {}
  }

  // Periodic SQLite maintenance (skip in Postgres mode)
  if (!isPostgres) {
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
