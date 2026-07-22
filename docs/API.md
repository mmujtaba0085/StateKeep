# StateKeep API Reference

**Base URL:** `https://your-statekeep-instance.com`  
**Auth header:** `x-api-key: sk_<keyId>_<secret>`  
**Content-Type:** `application/json` for all POST/PUT/PATCH requests

---

## Table of Contents

1. [Health & Monitoring](#1-health--monitoring)
2. [Authentication](#2-authentication)
3. [API Key Management](#3-api-key-management)
4. [Definitions](#4-definitions)
5. [Actors](#5-actors)
6. [Scheduled Events](#6-scheduled-events)
7. [Webhooks](#7-webhooks)
8. [Admin](#8-admin)
9. [Organizations (Admin)](#9-organizations-admin)
10. [Archives & Export](#10-archives--export)
11. [Priority & Headers](#11-priority--headers)
12. [Error Reference](#12-error-reference)

---

## 1. Health & Monitoring

### GET /v1/health

No authentication required. Returns server status, APV engine mode, and uptime.

**Response 200:**
```json
{
  "status":    "ok",
  "engine":    "real",
  "db":        "ok",
  "uptime":    3612,
  "timestamp": "2025-05-19T10:00:00.000Z"
}
```

| Field | Values | Meaning |
|-------|--------|---------|
| `status` | `ok` / `degraded` | `degraded` if DB is unreachable |
| `engine` | `real` / `fallback` | `fallback` = APV .so not loaded, migrations paused |
| `db` | `ok` / `error` | SQLite reachability |
| `uptime` | integer (seconds) | Server process uptime |

---

### GET /v1/health/workers

No authentication required. Reports heartbeat status for all background workers.

**Response 200** (all healthy) / **503** (any worker stale):
```json
{
  "healthy":          true,
  "checkedAt":        1716163200000,
  "staleThresholdMs": 120000,
  "workers": [
    {
      "workerId":   "migrate-worker-abc123",
      "workerType": "migrate-worker",
      "pid":        12345,
      "startedAt":  1716160000000,
      "lastBeat":   1716163190000,
      "staleSecs":  10,
      "healthy":    true
    }
  ]
}
```

A worker is considered stale if its last heartbeat is older than 2 minutes.

---

### GET /v1/health/queues

No authentication required. Returns real-time stats for the worker thread priority queue.

**Response 200:**
```json
{
  "workerCount": 20,
  "totals": {
    "queued":    { "high": 0,    "normal": 3,   "low": 12   },
    "served":    { "high": 1240, "normal": 8900, "low": 450  },
    "avgWaitMs": { "high": 2,    "normal": 8,   "low": 34   }
  },
  "perWorker": [
    {
      "slotIndex":  0,
      "queued":     { "high": 0, "normal": 1, "low": 0 },
      "served":     { "high": 62, "normal": 445, "low": 22 },
      "avgWaitMs":  { "high": 1, "normal": 9, "low": 30 }
    }
  ]
}
```

Three priority tiers: `high` (dashboard requests), `normal` (API calls), `low` (background migration). Served in weighted round-robin: 3 high → 2 normal → 1 low per round. Within each tier, requests are served in per-org round-robin so no single org can starve another.

---

### GET /v1/metrics

Returns Prometheus text-format metrics. No authentication required.

```
# HELP statekeep_actors_active Total active actors
# TYPE statekeep_actors_active gauge
statekeep_actors_active 1200

# HELP statekeep_actors_needs_rescue Actors in needs_rescue status
# TYPE statekeep_actors_needs_rescue gauge
statekeep_actors_needs_rescue 0

# HELP statekeep_migration_jobs_pending Pending migration jobs
# TYPE statekeep_migration_jobs_pending gauge
statekeep_migration_jobs_pending 3

# HELP statekeep_wal_size_bytes SQLite WAL file size in bytes
# TYPE statekeep_wal_size_bytes gauge
statekeep_wal_size_bytes 2097152

# HELP statekeep_api_latency_p99_ms API latency P99 in milliseconds
# TYPE statekeep_api_latency_p99_ms gauge
statekeep_api_latency_p99_ms 12
```

---

## 2. Authentication

### POST /v1/auth/login

Exchange dashboard credentials for an API key. No auth header required.

**Request:**
```json
{ "username": "admin", "password": "your-password" }
```

**Response 200:**
```json
{ "apiKey": "sk_abc123_..." }
```

**Response 401:**
```json
{ "error": "Invalid credentials" }
```

---

### POST /v1/auth/verify

Verify that an API key is valid and return its metadata. Requires the key being verified in the `x-api-key` header.

**Response 200:**
```json
{
  "valid": true,
  "keyId": "key_abc123",
  "label": "production",
  "tier":  "pro",
  "orgId": "org_xyz"
}
```

---

## 3. API Key Management

Requires `pro` or `enterprise` tier key.

### POST /v1/keys

Create a new API key for the authenticated org.

**Request:**
```json
{
  "label": "production-backend",
  "tier":  "pro"
}
```

`tier` values: `free` | `pro` | `enterprise` (default: `free`)

**Response 201:**
```json
{
  "keyId":  "key_abc123",
  "rawKey": "sk_abc123_<64-char-secret>",
  "label":  "production-backend",
  "tier":   "pro",
  "orgId":  "org_xyz",
  "note":   "Save this key — it will not be shown again."
}
```

The `rawKey` is returned exactly once. Store it securely.

---

### GET /v1/keys

List all API keys for the authenticated org. Secrets are never included.

**Response 200:**
```json
{
  "keys": [
    {
      "keyId":     "key_abc123",
      "label":     "production-backend",
      "tier":      "pro",
      "createdAt": 1716163200000,
      "revokedAt": null
    }
  ]
}
```

---

### POST /v1/keys/:keyId/rotate

Rotate a key — invalidate the existing secret and issue a new one. The `keyId` stays the same.

**Response 200:**
```json
{
  "keyId":  "key_abc123",
  "rawKey": "sk_abc123_<new-64-char-secret>",
  "note":   "Save this key — it will not be shown again."
}
```

---

### DELETE /v1/keys/:keyId

Revoke a key. Revoked keys return 401 immediately.

**Response 204** (no body)

---

## 4. Definitions

### PUT /v1/definitions

Deploy a new machine definition or update an existing one. Idempotent: re-deploying the same `id` with the same `definition` JSON is a no-op (returns `idempotent: true`).

**Request body:**
```json
{
  "id":           "loan-v2",
  "definition":   { "initial": "idle", "states": { ... } },
  "parentId":     "loan-v1",
  "historyPath":  ["APPLY", "PAY_FEE"],
  "stateMapping": { "in_review": "under_review" },
  "contextTransform": {
    "newPath.field": "oldPath.field"
  },
  "confirmToken": "a3f1b2c4-...",
  "refinement":   1
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | Yes | Unique version identifier |
| `definition` | object | Yes | XState v5 machine config (JSON only — no functions) |
| `parentId` | string | No | Previous version to migrate actors from |
| `historyPath` | string[] | No | Ordered event sequence; only actors whose history contains this path are eligible for migration. Omit or `[]` for wildcard (all actors) |
| `stateMapping` | object | No | `{ oldStateName: newStateName }` — remap actors in removed/renamed states |
| `contextTransform` | object | No | `{ "new.path": "old.path" }` — dot-notation field renames applied to actor context during migration |
| `confirmToken` | string | No | UUID from a prior `requires_confirmation` response |
| `refinement` | integer | No | APV refinement level (default: 1) |

**Response 201** (deployed):
```json
{
  "id":              "loan-v2",
  "parentId":        "loan-v1",
  "deployedAt":      1716163200000,
  "affectedActors":  120,
  "strandedTagged":  0,
  "engineAvailable": true,
  "idempotent":      false,
  "warnings": [
    { "type": "DEAD_END_STATE", "severity": "warn", "message": "State 'review' has no outgoing transitions" }
  ]
}
```

**Response 200** (requires confirmation — definition NOT written yet):
```json
{
  "status":       "requires_confirmation",
  "strandedActors": [
    { "currentState": "in_progress", "count": 8 }
  ],
  "safeActors":   34,
  "confirmToken": "a3f1b2c4-...",
  "expiresIn":    300,
  "message":      "8 actors are in states removed by this version..."
}
```

Re-submit with `confirmToken` to tag stranded actors `needs_rescue` and proceed with deployment.

**Validation errors (400):**
```json
{
  "error": "Definition validation failed",
  "errors": [
    { "type": "INVALID_TRANSITION", "severity": "error", "message": "State 'idle' transitions to undefined state 'typo'" }
  ]
}
```

Hard error types: `EMPTY_STATES`, `INVALID_INITIAL`, `INVALID_TRANSITION`, `COMPOUND_NO_INITIAL`, `XSTATE_ERROR`, `UNDEFINED_INITIAL`

Soft warnings (stored, non-blocking): `DEAD_END_STATE`, `UNREACHABLE_STATE`, `NO_TERMINAL_STATE`

---

### POST /v1/definitions/validate

Validate a definition without deploying or writing anything to the database.

**Request:**
```json
{ "definition": { "initial": "idle", "states": { ... } } }
```

**Response 200** (valid):
```json
{ "valid": true, "warnings": [] }
```

**Response 400** (invalid):
```json
{
  "valid": false,
  "errors": [
    { "type": "INVALID_INITIAL", "severity": "error", "message": "..." }
  ]
}
```

---

### POST /v1/definitions/preview

Dry-run a deployment: compute which actors would migrate, which would be stranded, and what `stateMapping` would be needed. Nothing is written.

**Request:** Same body as `PUT /v1/definitions` (without `confirmToken`)

**Response 200:**
```json
{
  "wouldMigrate": 45,
  "wouldStrand":  8,
  "strandedStates": ["in_progress"],
  "requiresConfirmation": true
}
```

---

### POST /v1/definitions/scenario

Run event sequences against a definition without spawning persistent actors. Used for testing machine logic before deployment.

**Request:**
```json
{
  "definition": { "initial": "idle", "states": { ... } },
  "scenarios": [
    {
      "name":           "happy path",
      "initialContext": { "userId": "u_001" },
      "events":         ["START", "SUBMIT", "APPROVE"],
      "expectedStates": ["idle", "running", "submitted", "approved"],
      "expectDone":     true
    }
  ]
}
```

Events can be plain strings (`"START"`) or objects (`{ "type": "START", "payload": {} }`).

`expectDone: true` fails if the machine is not in a final state after all events. `expectDone: false` fails if the machine unexpectedly reaches a final state.

**Response 200:**
```json
{
  "results": [
    {
      "name":    "happy path",
      "passed":  true,
      "states":  ["idle", "running", "submitted", "approved"],
      "finalState": "approved",
      "done":    true
    }
  ]
}
```

---

### GET /v1/definitions

List all definitions. Returns latest version of each machine family by default.

**Query params:** `?limit=50&offset=0`

**Response 200:**
```json
{
  "definitions": [
    {
      "id":         "loan-v2",
      "machineId":  "loan",
      "parentId":   "loan-v1",
      "deployedAt": 1716163200000,
      "actorCount": 120
    }
  ]
}
```

---

### GET /v1/definitions/:id

Get a single definition including its machine JSON.

**Response 200:**
```json
{
  "id":         "loan-v2",
  "machineId":  "loan",
  "parentId":   "loan-v1",
  "definition": { "initial": "idle", "states": { ... } },
  "deployedAt": 1716163200000
}
```

---

### GET /v1/definitions/:id/status

Get deployment status and migration progress for a definition version.

**Response 200:**
```json
{
  "id":            "loan-v2",
  "totalJobs":     120,
  "completed":     115,
  "pending":       5,
  "failed":        0,
  "percentDone":   95.8
}
```

---

### GET /v1/definitions/:id/diff

Show which states are added, removed, or unchanged compared to the parent definition.

**Response 200:**
```json
{
  "added":     ["compliance_review"],
  "removed":   ["in_review"],
  "unchanged": ["idle", "approved", "rejected"]
}
```

---

### GET /v1/definitions/:id/stats

Aggregate actor counts by current state for this definition version.

**Response 200:**
```json
{
  "id": "loan-v2",
  "byState": {
    "idle":               42,
    "underwriting":       35,
    "compliance_review":  18,
    "approved":           25
  }
}
```

---

### GET /v1/machines/:id/stats

Aggregate actor counts across all versions of a machine family.

**Response 200:**
```json
{
  "machineId": "loan",
  "totalActors": 220,
  "byVersion": {
    "loan-v1": 100,
    "loan-v2": 120
  }
}
```

---

## 5. Actors

### POST /v1/actors

Spawn a new actor instance.

**Request:**
```json
{
  "definitionId":   "loan-v2",
  "initialContext": {
    "applicantId": "usr-001",
    "amount":      50000
  }
}
```

**Machine alias (recommended pattern):** Pass the **machineId** (the root definition's `id`) instead of a specific version. The server resolves it to the latest non-deprecated version in that family automatically. This means client code never needs to track which version is "current" — new deployments are picked up on the next spawn without any client change.

```json
{ "definitionId": "loan" }
```

This works because every definition has a `machineId` — the ID of the first definition in its family, inherited through the `parentId` chain. Passing that root ID triggers the alias resolution.

**Response 201:**
```json
{
  "id":           "actor_7f3a1b2c...",
  "definitionId": "loan-v3",
  "requestedAs":  "loan",
  "stateValue":   "idle",
  "context":      { "applicantId": "usr-001", "amount": 50000 },
  "done":         false
}
```

`requestedAs` is present only when the provided `definitionId` was resolved to a different (newer) version. When an exact version ID was given, `requestedAs` is absent.

---

### POST /v1/actors/bulk

Spawn up to 500 actors in a single request. Processed in batches of 50 internally.

**Request:**
```json
{
  "actors": [
    { "definitionId": "loan-v2", "initialContext": { "applicantId": "u_001" } },
    { "definitionId": "loan-v2", "initialContext": { "applicantId": "u_002" } }
  ]
}
```

The machine alias works here too: pass the machineId root ID in any item's `definitionId` and the server resolves it to the latest version. All unique definition IDs in the batch are resolved in a single pre-pass (not N per-actor DB lookups).

**Response 207** (Multi-Status):
```json
{
  "created": [
    {
      "id":           "actor_...",
      "definitionId": "loan-v3",
      "requestedAs":  "loan",
      "stateValue":   "idle"
    }
  ],
  "failed":  [],
  "total":   2
}
```

`requestedAs` appears in each created item when the provided ID was resolved to a different version. Items in `failed` contain `{ index, definitionId, error }`.

---

### GET /v1/actors

List actors with optional filters. Cursor-paginated.

**Query params:**

| Param | Type | Description |
|-------|------|-------------|
| `status` | string | Filter by status: `active`, `migrating`, `needs_rescue`, `terminated`, `archived` |
| `definitionId` | string | Filter to a specific definition version |
| `limit` | integer | Page size (default 50, max 200) |
| `after` | string | Cursor from previous page's `nextCursor` |

**Response 200:**
```json
{
  "actors": [
    {
      "id":           "actor_7f3a1b2c...",
      "definitionId": "loan-v2",
      "stateValue":   "underwriting",
      "status":       "active",
      "createdAt":    1716163200000,
      "updatedAt":    1716163260000
    }
  ],
  "nextCursor": "actor_7f3a...",
  "hasMore":    true
}
```

---

### GET /v1/actors/needs-rescue

Convenience alias for `GET /v1/actors?status=needs_rescue`. Returns actors that are stranded and need manual intervention.

---

### GET /v1/actors/:id

Get full state for a single actor including decrypted context.

**Response 200:**
```json
{
  "id":                 "actor_7f3a1b2c...",
  "definitionId":       "loan-v2",
  "stateValue":         "underwriting",
  "status":             "active",
  "context":            { "applicantId": "usr-001", "amount": 50000 },
  "historyFingerprint": "a3f1b2c4d5e6f7a8",
  "createdAt":          1716163200000,
  "updatedAt":          1716163260000,
  "done":               false
}
```

---

### POST /v1/actors/:id/event

Send an event to an actor, advancing it to the next state.

**Headers:**
- `X-Priority: high` — optional; routes this request to the high-priority queue (used internally by the dashboard). Default: `normal`.

**Request:**
```json
{
  "type":           "APPROVE",
  "payload":        { "approvedBy": "officer_42" },
  "idempotencyKey": "evt_req_abc123"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | string | Yes | Event type (must match a transition in the definition) |
| `payload` | object | No | Merged into actor context |
| `idempotencyKey` | string | No | If provided, duplicate requests with the same key return the current state instead of re-processing. Format: `[a-zA-Z0-9_\-.:]`, max 128 chars |

**Response 200:**
```json
{
  "actorId":    "actor_7f3a1b2c...",
  "stateValue": "compliance_review",
  "context":    { "applicantId": "usr-001", "approvedBy": "officer_42" },
  "done":       false,
  "migratedTo": null
}
```

`migratedTo` is non-null if this event also triggered a migration to a new definition version.

When `idempotencyKey` was already processed, the response includes `"idempotent": true`.

**Error responses:**

| Code | `code` field | Meaning |
|------|-------------|---------|
| 404 | — | Actor not found |
| 409 | `ACTOR_NEEDS_RESCUE` | Actor is stranded — events blocked until rescued |
| 400 | — | Other validation error |

---

### GET /v1/actors/:id/events

Cursor-paginated event history for an actor.

**Query params:** `?limit=50&after=0`

`after` is an event row ID (integer). Use the last event's `id` as cursor for the next page.

**Response 200:**
```json
{
  "actorId": "actor_7f3a1b2c...",
  "events": [
    {
      "id":          1,
      "type":        "SPAWN",
      "payload":     null,
      "tick":        42,
      "processedAt": 1716163200000
    },
    {
      "id":          2,
      "type":        "APPROVE",
      "payload":     { "approvedBy": "officer_42" },
      "tick":        45,
      "processedAt": 1716163260000
    }
  ],
  "nextCursor": 2,
  "hasMore":    false
}
```

---

### GET /v1/actors/:id/decisions

Migration routing decisions for an actor — the full audit trail of which version each migration attempted to route the actor to and why.

**Response 200:**
```json
{
  "actorId": "actor_7f3a1b2c...",
  "decisions": [
    {
      "evaluatedAt":      1716163200000,
      "decision":         "migrated",
      "reason":           "prefix_match",
      "fromDefinitionId": "loan-v1",
      "toDefinitionId":   "loan-v2",
      "prefixHash":       "a3f1b2c4..."
    }
  ]
}
```

---

### GET /v1/actors/:id/export

Export a complete actor record — state, context, and full event history — as a single JSON document.

**Response 200:** Full actor JSON including all events.

---

### DELETE /v1/actors/:id

Terminate an actor. The actor's state is preserved in the database but no further events can be sent.

**Headers:** `X-Priority: high` — optional, same semantics as event endpoint.

**Response 200:**
```json
{
  "actorId":    "actor_7f3a1b2c...",
  "stateValue": "approved",
  "status":     "terminated"
}
```

---

### PATCH /v1/actors/:id

Update actor metadata. Currently supports resetting `needs_rescue` actors back to `active`.

**Request:**
```json
{ "status": "active" }
```

**Response 200:**
```json
{ "id": "actor_7f3a1b2c...", "status": "active" }
```

---

## 6. Scheduled Events

### POST /v1/actors/:id/schedule

Schedule a future event to be sent to an actor.

**Request:**
```json
{
  "type":    "SEND_REMINDER",
  "payload": { "channel": "email" },
  "fireAt":  1716250000000
}
```

`fireAt` is a Unix timestamp in **milliseconds**. The scheduler worker checks for due events every 5 seconds.

**Response 201:**
```json
{
  "scheduleId": "sched_abc123",
  "actorId":    "actor_7f3a1b2c...",
  "eventType":  "SEND_REMINDER",
  "fireAt":     1716250000000,
  "status":     "pending"
}
```

---

### GET /v1/actors/:id/schedule

List all scheduled events for an actor.

**Response 200:**
```json
{
  "scheduled": [
    {
      "scheduleId": "sched_abc123",
      "eventType":  "SEND_REMINDER",
      "fireAt":     1716250000000,
      "status":     "pending",
      "createdAt":  1716163200000
    }
  ]
}
```

Status values: `pending`, `fired`, `failed`, `cancelled`

---

### DELETE /v1/actors/:id/schedule/:scheduleId

Cancel a pending scheduled event.

**Response 204** (no body), or **404** if not found / already fired.

---

### GET /v1/scheduled *(admin)*

List all pending scheduled events across all orgs. Requires `X-Admin-Key` header.

**Response 200:**
```json
{
  "scheduled": [
    {
      "scheduleId": "sched_abc123",
      "actorId":    "actor_7f3a1b2c...",
      "orgId":      "org_xyz",
      "eventType":  "SEND_REMINDER",
      "fireAt":     1716250000000,
      "status":     "pending"
    }
  ]
}
```

---

### GET /v1/scheduled/dead-letter *(admin)*

List scheduled events that have exhausted all retry attempts. Requires `X-Admin-Key` header.

---

## 7. Webhooks

### POST /v1/webhooks

Register a webhook endpoint. The URL must be HTTPS.

**Request:**
```json
{
  "url":    "https://yourapp.com/webhooks/statekeep",
  "secret": "at-least-16-chars-random-secret",
  "events": ["state.changed", "actor.migrated"]
}
```

Valid event types:
- `state.changed` — actor transitioned to a new state
- `actor.migrated` — actor migrated to a new definition version
- `actor.terminated` — actor was terminated
- `actor.needs_rescue` — actor became stranded
- `scheduled.fired` — a scheduled event was delivered
- `scheduled.failed` — a scheduled event failed all retries

**Response 201:**
```json
{
  "id":        "wh_abc123",
  "url":       "https://yourapp.com/webhooks/statekeep",
  "events":    ["state.changed", "actor.migrated"],
  "active":    true,
  "createdAt": 1716163200000
}
```

The secret is stored encrypted and **never returned** after creation.

**Signature verification:**

Every webhook delivery includes a `X-StateKeep-Signature: sha256=<hex>` header. Verify it with HMAC-SHA256:

```js
const expected = 'sha256=' + crypto
  .createHmac('sha256', YOUR_SECRET)
  .update(rawBody)   // raw request body bytes
  .digest('hex');
const valid = crypto.timingSafeEqual(
  Buffer.from(expected),
  Buffer.from(request.headers['x-statekeep-signature'])
);
```

**Webhook payload envelope:**
```json
{
  "event":   "state.changed",
  "actorId": "actor_7f3a1b2c...",
  "orgId":   "org_xyz",
  "ts":      1716163260000,
  "data": {
    "stateValue": "approved",
    "context":    { "applicantId": "usr-001" }
  }
}
```

---

### GET /v1/webhooks

List all webhooks for the authenticated org. Secrets are never included.

**Response 200:**
```json
{
  "webhooks": [
    {
      "id":        "wh_abc123",
      "url":       "https://yourapp.com/webhooks/statekeep",
      "events":    ["state.changed"],
      "active":    true,
      "createdAt": 1716163200000
    }
  ]
}
```

---

### GET /v1/webhooks/:id

Get a single webhook.

**Response 200:** Single webhook object (same shape as list item).

---

### PATCH /v1/webhooks/:id

Update a webhook — change URL, events list, or activate/deactivate.

**Request:**
```json
{
  "url":    "https://newurl.com/hook",
  "events": ["state.changed", "actor.terminated"],
  "active": false
}
```

All fields are optional. **Response 200:** Updated webhook object.

---

### DELETE /v1/webhooks/:id

Deactivate a webhook. The record is kept for audit purposes (`active: false`).

**Response 204** (no body)

---

### POST /v1/webhooks/:id/ping

Queue a test delivery to verify the endpoint is reachable.

**Response 200:**
```json
{ "deliveryId": "del_abc123", "status": "queued" }
```

---

### GET /v1/webhooks/:id/deliveries

List recent delivery attempts for a webhook.

**Response 200:**
```json
{
  "deliveries": [
    {
      "deliveryId":   "del_abc123",
      "event":        "state.changed",
      "status":       "delivered",
      "responseCode": 200,
      "attemptedAt":  1716163260000,
      "attempts":     1
    }
  ]
}
```

---

## 8. Admin

Admin endpoints require the `X-Admin-Key` header (the `STATEKEEP_ADMIN_KEY` environment variable value). Do not expose admin keys to API clients.

### POST /v1/admin/workers/:type/restart

Force-restart a worker pool. `type` must be a registered worker type.

**Response 200:**
```json
{ "restarted": true, "workerType": "migrate-worker" }
```

---

### POST /v1/admin/actors/:id/force-archive

Force an actor into `archived` status immediately, bypassing the GC retention window.

**Response 200:**
```json
{ "actorId": "actor_7f3a1b2c...", "status": "archived" }
```

---

### DELETE /v1/health/workers/:workerId *(admin)*

Delete a stale worker heartbeat record. Use when a worker shows unhealthy but the process has since restarted.

**Response 204** (deleted) / **404** (not found)

---

## 9. Organizations (Admin)

Requires `X-Admin-Key` header.

### GET /v1/orgs

List all organizations.

**Response 200:**
```json
{
  "orgs": [
    { "id": "org_xyz", "name": "Acme Corp", "createdAt": 1716163200000 }
  ]
}
```

---

### POST /v1/orgs

Create a new organization.

**Request:**
```json
{ "name": "Acme Corp" }
```

**Response 201:**
```json
{ "id": "org_xyz", "name": "Acme Corp", "createdAt": 1716163200000 }
```

---

### DELETE /v1/orgs/:id

Delete an organization and all its associated data.

**Response 204** (no body)

---

### POST /v1/orgs/:id/keys

Provision an API key for a specific org. Admin use for onboarding new customers.

**Request:**
```json
{ "label": "customer-key", "tier": "pro" }
```

**Response 201:** Same as `POST /v1/keys` response.

---

### GET /v1/orgs/:id/keys

List API keys for a specific org.

**Response 200:** Same as `GET /v1/keys` response.

---

## 10. Archives & Export

### GET /v1/archives

List archived actor metadata (actors GC'd by the gc-worker).

**Query params:** `?limit=50&after=0`

**Response 200:**
```json
{
  "archives": [
    {
      "actorId":      "actor_7f3a1b2c...",
      "definitionId": "loan-v2",
      "archivedAt":   1716163200000,
      "archivePath":  "/opt/statekeep/archives/actor_7f3a.json.gz"
    }
  ]
}
```

---

### GET /v1/machines/:id/export

Export all actors for a machine family as JSON or CSV.

**Query params:** `?format=json` or `?format=csv`

**Response 200:** JSON array or CSV text depending on `format`.

---

### POST /v1/actors/:id/restore

Restore an archived actor back to `active` status.

**Response 200:**
```json
{ "actorId": "actor_7f3a1b2c...", "status": "active", "restored": true }
```

---

## 11. Priority & Headers

### X-Priority header

The `POST /v1/actors/:id/event` and `DELETE /v1/actors/:id` endpoints accept an optional `X-Priority` header that controls queue placement in the worker thread pool.

| Value | Queue | Used by |
|-------|-------|---------|
| `urgent` | Urgent queue (burst mode) | Dashboard manual actions (send event, get state, terminate) |
| `high` | High-priority queue (3/round) | Dashboard background polling |
| `normal` | Normal queue (2/round) | Default for all API calls |
| *(absent)* | Normal queue | Same as `normal` |

Background workers (migrate-worker) use `low` priority internally (not client-settable).

**Round-robin schedule:** 3 high → 2 normal → 1 low per round, then repeat. `urgent` requests get exclusive access for the first 5 seconds of continuous urgent load, then 1 urgent slot per round interleaved with the normal schedule. Within each tier, requests are served in per-org round-robin so one org's burst cannot starve another.

You generally do not need to set `X-Priority` — the default `normal` is appropriate for all application-tier API calls. Use `high` only if you are building a dashboard-like UI that requires lower latency for read-after-write consistency.

---

## 12. Error Reference

All error responses follow this shape:
```json
{
  "error": "Human-readable message",
  "code":  "MACHINE_READABLE_CODE"
}
```

`code` is only present when there is a specific machine-readable error type.

### HTTP Status Codes

| Code | Meaning |
|------|---------|
| 200 | Success (or `requires_confirmation` for definitions) |
| 201 | Created |
| 204 | Deleted (no body) |
| 207 | Multi-Status (bulk operations — check `failed` array) |
| 400 | Validation error — fix request body |
| 401 | Missing or invalid API key |
| 403 | Insufficient tier for this endpoint |
| 404 | Resource not found (or org isolation — cross-org resources always 404, never 403) |
| 409 | Conflict — `ACTOR_NEEDS_RESCUE` or actor is terminated/archived |
| 503 | Workers unhealthy (only on `GET /v1/health/workers`) |

### Named Error Codes

| Code | Endpoint | Meaning |
|------|----------|---------|
| `ACTOR_NEEDS_RESCUE` | `POST /v1/actors/:id/event` | Actor is stranded; rescue it first via `PATCH /v1/actors/:id` |
| `EMPTY_STATES` | `PUT /v1/definitions` | Definition has no states |
| `INVALID_INITIAL` | `PUT /v1/definitions` | `initial` references a nonexistent state |
| `INVALID_TRANSITION` | `PUT /v1/definitions` | A transition targets a nonexistent state |
| `COMPOUND_NO_INITIAL` | `PUT /v1/definitions` | Compound state has children but no `initial` |
| `XSTATE_ERROR` | `PUT /v1/definitions` | XState threw during machine construction |
| `UNDEFINED_INITIAL` | `PUT /v1/definitions` | Machine accepted but started with `value = undefined` |
| `STATE_NOT_MAPPABLE` | Internal (HYDRATE) | Migration aborted — actor's state has no mapping in new version |
| `CONTEXT_TRANSFORM_FAILED` | Internal (HYDRATE) | `contextTransform` failed — migration aborted |

### REQUIRES_CONFIRMATION flow

When `PUT /v1/definitions` returns HTTP 200 (not 201) with `status: "requires_confirmation"`:

1. **Save** the `confirmToken` (expires in 5 minutes by default)
2. **Review** `strandedActors` — if any are unexpected, add `stateMapping` to reroute them
3. **Re-submit** the same request body with `"confirmToken": "<token>"` added
4. The definition is written, stranded actors are tagged `needs_rescue`

If the confirm token expires or the stranded count grows by >10% between preview and confirm, you get a fresh preview automatically.
