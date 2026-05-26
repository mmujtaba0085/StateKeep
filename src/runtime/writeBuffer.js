/**
 * src/runtime/writeBuffer.js
 *
 * Deferred write buffer — collects SQLite writes from the hot event path
 * and flushes them in a single transaction every FLUSH_MS milliseconds.
 *
 * State updates: Map keyed by actorId — latest write wins within each window.
 *   100 events on the same actor in 50ms → one DB row update, not 100.
 *
 * Event + decision inserts: Arrays — all rows preserved (append-only).
 *
 * All three flushed in one transaction per interval → consistent snapshot.
 * Crash window = up to FLUSH_MS of unwritten state (default 50ms).
 *
 * flushActor(id): force-writes one actor immediately (called before termination
 * or migration so terminal status always lands on a persisted state).
 */

import { getDb, encrypt } from '../registry/db.js';

const FLUSH_MS = 50;

class WriteBuffer {
  constructor() {
    this._states    = new Map();  // actorId → { stateValue, context, ... }
    this._events    = [];         // event row objects
    this._decisions = [];         // positional arg arrays for migration_decisions
    this._pending   = new Set();  // `${actorId}:${idempotencyKey}` for in-flight dedup
    this._stmts     = null;
    this._timer     = setInterval(() => this.flush(), FLUSH_MS).unref();
  }

  queueState(actorId, data) {
    this._states.set(actorId, data);
  }

  queueEvent(row) {
    this._events.push(row);
    if (row.idempotency_key) {
      this._pending.add(`${row.actor_id}:${row.idempotency_key}`);
    }
  }

  queueDecision(args) {
    this._decisions.push(args);
  }

  // True if this idempotency key is queued but not yet flushed to DB.
  hasPendingEvent(actorId, idempotencyKey) {
    return this._pending.has(`${actorId}:${idempotencyKey}`);
  }

  // Force-write one actor's state immediately — used before termination/migration.
  flushActor(actorId) {
    const data = this._states.get(actorId);
    if (!data) return;
    this._states.delete(actorId);
    try {
      this._getStmts().state.run(this._serialize(actorId, data));
    } catch (err) {
      console.error(`[writeBuffer] flushActor(${actorId}) error:`, err.message);
    }
  }

  flush() {
    if (this._states.size === 0 && this._events.length === 0 && this._decisions.length === 0) return;

    const states    = [...this._states.entries()];
    const events    = this._events.splice(0);
    const decisions = this._decisions.splice(0);
    this._states.clear();

    for (const ev of events) {
      if (ev.idempotency_key) this._pending.delete(`${ev.actor_id}:${ev.idempotency_key}`);
    }

    if (states.length === 0 && events.length === 0 && decisions.length === 0) return;

    try {
      const { state: stateStmt, event: eventStmt, decision: decisionStmt } = this._getStmts();
      getDb().transaction(() => {
        for (const [id, d] of states)  stateStmt.run(this._serialize(id, d));
        for (const ev of events)       eventStmt.run(ev);
        for (const dec of decisions)   decisionStmt.run(...dec);
      })();
    } catch (err) {
      console.error('[writeBuffer] flush error:', err.message);
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
      region_fingerprints:  d.regionFingerprints ? JSON.stringify(d.regionFingerprints) : null,
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
