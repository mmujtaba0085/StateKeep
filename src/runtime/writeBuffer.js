/**
 * src/runtime/writeBuffer.js
 *
 * Deferred write buffer — collects writes from the hot event path and flushes
 * them in a single transaction every FLUSH_MS milliseconds.
 *
 * State updates: Map keyed by actorId — latest write wins within each window.
 * Event + decision inserts: Arrays — all rows preserved (append-only).
 *
 * SQLite path: synchronous better-sqlite3 transaction.
 * Postgres path: async pg transaction with _flushing mutex to prevent overlap.
 *
 * flushActor(id): force-writes one actor immediately (called before termination
 * or migration so terminal status always lands on a persisted state).
 */

import { getDb, encrypt, isPostgres } from '../registry/db.js';
import { serializeRegionFingerprints } from '../registry/regionFingerprintCodec.js';

const FLUSH_MS   = parseInt(process.env.STATEKEEP_WRITE_BUFFER_MS ?? '50', 10);
const HIGH_WATER = 200;

class WriteBuffer {
  constructor() {
    this._states    = new Map();
    this._events    = [];
    this._decisions = [];
    this._pending   = new Set();
    this._stmts     = null;
    this._flushing  = false;   // Postgres-mode concurrent-flush guard
    this._timer     = setInterval(() => { this.flush().catch(() => {}); }, FLUSH_MS).unref();
  }

  queueState(actorId, data) {
    this._states.set(actorId, this._serialize(actorId, data));
    if (this._states.size + this._events.length >= HIGH_WATER) this.flush();
  }

  queueEvent(row) {
    this._events.push(row);
    if (row.idempotency_key) this._pending.add(`${row.actor_id}:${row.idempotency_key}`);
    if (this._states.size + this._events.length >= HIGH_WATER) this.flush();
  }

  queueDecision(args) {
    this._decisions.push(args);
  }

  hasPendingEvent(actorId, idempotencyKey) {
    return this._pending.has(`${actorId}:${idempotencyKey}`);
  }

  flushActor(actorId) {
    const row = this._states.get(actorId);
    if (!row) return;
    this._states.delete(actorId);
    if (isPostgres) {
      // Fire-and-forget; caller (terminateActor) awaits the subsequent updateActorStatus.
      import('./db-postgres.js').then(({ query }) => {
        query(
          `UPDATE actors SET state_value=$1, context_json=$2, history_fingerprint=$3,
            region_fingerprints=$4, last_event_tick=$5, status=$6, updated_at=$7 WHERE id=$8`,
          [row.state_value, row.context_json, row.history_fingerprint,
           row.region_fingerprints, row.last_event_tick, row.status, row.updated_at, row.id]
        ).catch(e => console.error(`[writeBuffer] flushActor PG ${actorId}:`, e.message));
      });
      return;
    }
    try {
      this._getStmts().state.run(row);
    } catch (err) {
      console.error(`[writeBuffer] flushActor(${actorId}) error:`, err.message);
    }
  }

  flush() {
    if (this._states.size === 0 && this._events.length === 0 && this._decisions.length === 0) {
      return Promise.resolve();
    }

    const rows      = [...this._states.values()];
    const events    = this._events.splice(0);
    const decisions = this._decisions.splice(0);
    this._states.clear();

    for (const ev of events) {
      if (ev.idempotency_key) this._pending.delete(`${ev.actor_id}:${ev.idempotency_key}`);
    }

    if (rows.length === 0 && events.length === 0 && decisions.length === 0) return Promise.resolve();

    if (isPostgres) {
      return this._flushPostgres(rows, events, decisions);
    }

    try {
      const { state: stateStmt, event: eventStmt, decision: decisionStmt } = this._getStmts();
      getDb().transaction(() => {
        for (const row of rows)      stateStmt.run(row);
        for (const ev of events)     eventStmt.run(ev);
        for (const dec of decisions) decisionStmt.run(...dec);
      })();
    } catch (err) {
      console.error('[writeBuffer] flush error:', err.message);
    }
    return Promise.resolve();
  }

  async _flushPostgres(rows, events, decisions) {
    if (this._flushing) return;
    this._flushing = true;
    try {
      const { transaction } = await import('../registry/db-postgres.js');
      await transaction(async (client) => {
        for (const row of rows) {
          await client.query(
            `UPDATE actors SET state_value=$1, context_json=$2, history_fingerprint=$3,
               region_fingerprints=$4, last_event_tick=$5, status=$6, updated_at=$7 WHERE id=$8`,
            [row.state_value, row.context_json, row.history_fingerprint,
             row.region_fingerprints, row.last_event_tick, row.status, row.updated_at, row.id]
          );
        }
        for (const ev of events) {
          await client.query(
            `INSERT INTO events
               (actor_id, org_id, event_type, event_payload, tick, processed_at, idempotency_key)
             VALUES ($1,$2,$3,$4,$5,$6,$7)
             ON CONFLICT (actor_id, org_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING`,
            [ev.actor_id, ev.org_id, ev.event_type, ev.event_payload,
             ev.tick, ev.processed_at, ev.idempotency_key ?? null]
          );
        }
        for (const dec of decisions) {
          await client.query(
            `INSERT INTO migration_decisions
               (actor_id, org_id, deployment_id, trigger, evaluated_at, decision, reason,
                from_definition_id, to_definition_id, actor_fingerprint, prefix_hash, created_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
            dec
          );
        }
      });
    } catch (err) {
      console.error('[writeBuffer] Postgres flush error:', err.message);
    } finally {
      this._flushing = false;
    }
  }

  _getStmts() {
    if (this._stmts) return this._stmts;
    const db = getDb();
    this._stmts = {
      state: db.prepare(`
        UPDATE actors
        SET state_value         = @state_value,
            context_json        = @context_json,
            history_fingerprint = @history_fingerprint,
            region_fingerprints = @region_fingerprints,
            last_event_tick     = @last_event_tick,
            status              = @status,
            updated_at          = @updated_at
        WHERE id = @id
      `),
      event: db.prepare(`
        INSERT OR IGNORE INTO events
          (actor_id, org_id, event_type, event_payload, tick, processed_at, idempotency_key)
        VALUES (@actor_id, @org_id, @event_type, @event_payload, @tick, @processed_at, @idempotency_key)
      `),
      decision: db.prepare(`
        INSERT INTO migration_decisions
          (actor_id, org_id, deployment_id, trigger, evaluated_at, decision, reason,
           from_definition_id, to_definition_id, actor_fingerprint, prefix_hash, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      `),
    };
    return this._stmts;
  }

  _serialize(id, d) {
    return {
      id,
      state_value:          d.stateValue != null ? JSON.stringify(d.stateValue) : null,
      context_json:         d.context    != null ? encrypt(Buffer.from(JSON.stringify(d.context))) : null,
      history_fingerprint:  String(d.historyFingerprint ?? '0'),
      region_fingerprints:  serializeRegionFingerprints(d.regionFingerprints),
      last_event_tick:      d.lastEventTick ?? null,
      status:               d.status ?? 'active',
      updated_at:           Date.now(),
    };
  }
}

let _buf = null;
export function getWriteBuffer() {
  if (!_buf) _buf = new WriteBuffer();
  return _buf;
}
