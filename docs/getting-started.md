# StateKeep — Getting Started Guide

StateKeep is a **production-grade actor state machine engine**. You define state machines as JSON, deploy them as versioned definitions, and the platform runs thousands of live actor instances — routing events, persisting state, and migrating actors between versions with zero downtime.

---

## Table of Contents

1. [Core Concepts](#1-core-concepts)
2. [Authentication](#2-authentication)
3. [Your First Machine](#3-your-first-machine)
4. [Spawning Actors](#4-spawning-actors)
5. [Sending Events](#5-sending-events)
6. [Reading State](#6-reading-state)
7. [Deploying a New Version (Additive)](#7-deploying-a-new-version-additive)
8. [Breaking Changes and the Rescue Flow](#8-breaking-changes-and-the-rescue-flow)
9. [historyPath — Targeting Specific Actors](#9-historypath--targeting-specific-actors)
10. [stateMapping — Renaming States Safely](#10-statemapping--renaming-states-safely)
11. [The Dashboard](#11-the-dashboard)
12. [API Quick Reference](#12-api-quick-reference)

---

## 1. Core Concepts

### Definitions
A **definition** is a state machine blueprint — a JSON document that describes all possible states and the transitions between them. Every definition has a unique `id`. When you deploy a new version, you give it a new `id` and point it at a `parentId`.

```
ticket-v1  ──parent──▶  ticket-v2  ──parent──▶  ticket-v3
```

All versions that share a root form a **machine family** (grouped by `machineId` in the dashboard).

### Actors
An **actor** is a live running instance of a definition. Each actor has:
- Its own unique ID
- Its own current **state** (e.g. `"underwriting"`)
- Its own **context** (arbitrary JSON you write to via events)
- A complete **event history** (every event it ever processed)

Actors are long-lived. A loan application actor might live for months, processing one event per week.

### APV — Anchor-Point Versioning
When you deploy `ticket-v3` as a child of `ticket-v2`, StateKeep must decide: which existing actors on `ticket-v2` migrate to `ticket-v3`?

The answer depends on **event history**, not just current state. Two actors both in state `assigned` may receive different migration decisions because their histories are different — one went through `escalated`, the other didn't.

This is APV: actors are routed to new versions based on a fingerprint of the events they have already processed. You control this with `historyPath` (see section 9).

### Actor Statuses
| Status | Meaning |
|---|---|
| `active` | Running normally |
| `migrating` | Being migrated to a new definition version |
| `needs_rescue` | Stranded — its current state no longer exists in any definition it could migrate to |
| `terminated` | Stopped by application code |
| `archived` | Soft-deleted |

### The Rescue Flow
When you deploy a new version that **removes a state**, actors currently in that removed state have nowhere to go — they are **stranded**. StateKeep never silently drops actors. Instead:

1. The first deploy attempt returns a preview with `confirmToken`
2. You see exactly how many actors are stranded and in which states
3. You either confirm (tag them `needs_rescue`) or add a `stateMapping` to reroute them

Stranded actors are frozen until you either deploy a rescue version or manually reset them.

---

## 2. Authentication

All API requests require an `x-api-key` header:

```bash
curl https://statekeep.161-97-163-210.nip.io/v1/health \
  -H "x-api-key: YOUR_API_KEY"
```

Your API key is shown in the dashboard sidebar after login. You can also copy it from there.

The dashboard is available at:
```
https://statekeep.161-97-163-210.nip.io/dashboard/
```

Login credentials are set by your server administrator (see `.env` `DASHBOARD_USERNAME` / `DASHBOARD_PASSWORD`).

The API Explorer (Swagger UI with auto-auth) is at:
```
https://statekeep.161-97-163-210.nip.io/api-explorer
```

---

## 3. Your First Machine

A state machine definition is a JSON object with `initial` and `states`. Here is the minimal structure:

```json
{
  "initial": "idle",
  "states": {
    "idle": {
      "on": {
        "START": "running"
      }
    },
    "running": {
      "on": {
        "STOP": "done"
      }
    },
    "done": {
      "type": "final"
    }
  }
}
```

**Rules:**
- `initial` must reference a key inside `states`
- Each state's `on` object maps event names to target state names
- `"type": "final"` marks a terminal state (actor is done)
- All transition targets must exist in `states`

### Deploy it

```bash
curl -X PUT https://statekeep.161-97-163-210.nip.io/v1/definitions \
  -H "x-api-key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "my-machine-v1",
    "definition": {
      "initial": "idle",
      "states": {
        "idle":    { "on": { "START": "running" } },
        "running": { "on": { "STOP": "done" } },
        "done":    { "type": "final" }
      }
    }
  }'
```

**Success response (201):**
```json
{
  "id": "my-machine-v1",
  "parentId": null,
  "deployedAt": 1716163200000,
  "affectedActors": 0,
  "engineAvailable": true,
  "idempotent": false,
  "warnings": []
}
```

`affectedActors` will be 0 on first deploy (no actors to migrate). The `warnings` array can contain soft issues like `UNREACHABLE_STATE` or `NO_TERMINAL_STATE` — these don't block deployment.

### Validation errors (400)

If your definition has invalid transitions or a missing `initial`, you get a 400 with an `errors` array:

```json
{
  "error": "Definition validation failed",
  "errors": [
    { "type": "INVALID_TRANSITION", "severity": "error", "message": "State 'idle' transitions to undefined state 'typo'" }
  ]
}
```

---

## 4. Spawning Actors

Once a definition is deployed, spawn actors against it:

```bash
curl -X POST https://statekeep.161-97-163-210.nip.io/v1/actors \
  -H "x-api-key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "definitionId": "my-machine-v1",
    "initialContext": {
      "userId": "u_abc123",
      "createdAt": "2025-05-19"
    }
  }'
```

**Response (201):**
```json
{
  "id": "actor_7f3a1b2c...",
  "definitionId": "my-machine-v1",
  "stateValue": "idle",
  "context": { "userId": "u_abc123", "createdAt": "2025-05-19" },
  "done": false
}
```

`initialContext` is optional but recommended — it lets you attach domain metadata (user IDs, amounts, timestamps) that rides along with the actor.

### Bulk spawn

Spawn up to 500 actors in one request:

```bash
curl -X POST https://statekeep.161-97-163-210.nip.io/v1/actors/bulk \
  -H "x-api-key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "actors": [
      { "definitionId": "my-machine-v1", "initialContext": { "userId": "u_001" } },
      { "definitionId": "my-machine-v1", "initialContext": { "userId": "u_002" } },
      { "definitionId": "my-machine-v1", "initialContext": { "userId": "u_003" } }
    ]
  }'
```

**Response (207):**
```json
{
  "created": [
    { "id": "actor_...", "definitionId": "my-machine-v1", "stateValue": "idle" },
    ...
  ],
  "failed": [],
  "total": 3
}
```

---

## 5. Sending Events

Move an actor forward by sending it an event:

```bash
curl -X POST https://statekeep.161-97-163-210.nip.io/v1/actors/ACTOR_ID/event \
  -H "x-api-key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "START",
    "payload": { "startedBy": "user_42" }
  }'
```

**Response (200):**
```json
{
  "actorId": "actor_7f3a1b2c...",
  "stateValue": "running",
  "context": { "userId": "u_abc123", "startedBy": "user_42" },
  "done": false,
  "migratedTo": null
}
```

`payload` fields are merged into the actor's context on each event. `migratedTo` will be non-null if this event also triggered a migration to a new definition version.

### Error responses

| Code | Meaning |
|---|---|
| 404 | Actor not found |
| 409 `ACTOR_NEEDS_RESCUE` | Actor is stranded — send events blocked until rescued |
| 400 | Other validation error |

---

## 6. Reading State

### Get a single actor

```bash
curl https://statekeep.161-97-163-210.nip.io/v1/actors/ACTOR_ID \
  -H "x-api-key: YOUR_API_KEY"
```

```json
{
  "id": "actor_7f3a1b2c...",
  "definitionId": "my-machine-v1",
  "stateValue": "running",
  "status": "active",
  "context": { "userId": "u_abc123" },
  "createdAt": 1716163200000,
  "updatedAt": 1716163260000
}
```

### List actors

```bash
# All actors
curl "https://statekeep.161-97-163-210.nip.io/v1/actors?limit=50" \
  -H "x-api-key: YOUR_API_KEY"

# Filter by status
curl "https://statekeep.161-97-163-210.nip.io/v1/actors?status=needs_rescue&limit=50" \
  -H "x-api-key: YOUR_API_KEY"
```

### Event history

```bash
curl "https://statekeep.161-97-163-210.nip.io/v1/actors/ACTOR_ID/events?limit=20" \
  -H "x-api-key: YOUR_API_KEY"
```

```json
{
  "actorId": "actor_7f3a1b2c...",
  "events": [
    { "id": 1, "type": "SPAWN",  "payload": null,                  "processedAt": 1716163200000 },
    { "id": 2, "type": "START",  "payload": { "startedBy": "u42" },"processedAt": 1716163260000 }
  ],
  "nextCursor": null
}
```

Paginate with `?afterId=<last event id>` for cursor-based pagination.

---

## 7. Deploying a New Version (Additive)

An **additive** migration adds new states or transitions without removing any existing states. All live actors can migrate safely because every state they might be in still exists in the new definition.

### What to do

Deploy the new version with a `parentId` pointing to the previous version:

```bash
curl -X PUT https://statekeep.161-97-163-210.nip.io/v1/definitions \
  -H "x-api-key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "my-machine-v2",
    "parentId": "my-machine-v1",
    "definition": {
      "initial": "idle",
      "states": {
        "idle":    { "on": { "START": "running", "QUEUE": "queued" } },
        "queued":  { "on": { "START": "running", "CANCEL": "cancelled" } },
        "running": { "on": { "STOP": "done", "ERROR": "failed" } },
        "failed":  { "on": { "RETRY": "running" } },
        "done":      { "type": "final" },
        "cancelled": { "type": "final" }
      }
    }
  }'
```

**Response (201):**
```json
{
  "id": "my-machine-v2",
  "parentId": "my-machine-v1",
  "affectedActors": 12,
  "strandedTagged": 0,
  "engineAvailable": true
}
```

`affectedActors: 12` means 12 actors from v1 were queued for migration to v2. They will migrate the next time they receive an event (lazy migration) or are processed by the background migration worker.

### What happens to running actors?

- Actors in states that exist in v2 (`idle`, `running`) → migrate to v2
- Their state is preserved (an actor in `running` on v1 stays in `running` on v2)
- Their context is preserved
- Their event history drives the APV fingerprint match (see section 9)

---

## 8. Breaking Changes and the Rescue Flow

A **breaking change** removes a state that live actors may currently be in. StateKeep does not silently drop actors — it requires explicit confirmation.

### Step 1 — First deploy attempt (preview)

Deploy the new definition normally. If any live actors are in states that no longer exist, you get a **200 response** (not 201) with:

```json
{
  "status": "requires_confirmation",
  "strandedActors": [
    { "currentState": "in_progress", "count": 8 }
  ],
  "safeActors": 34,
  "confirmToken": "a3f1b2c4-...",
  "expiresIn": 300,
  "message": "8 actors are in states that no longer exist in this definition. Confirm to tag them needs_rescue."
}
```

The definition is **not written** yet. This is a preview.

### Step 2 — Confirm (tag as rescue)

Re-send the same request with `confirmToken` added:

```bash
curl -X PUT https://statekeep.161-97-163-210.nip.io/v1/definitions \
  -H "x-api-key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "my-machine-v3",
    "parentId": "my-machine-v2",
    "confirmToken": "a3f1b2c4-...",
    "definition": { ... same definition ... }
  }'
```

**Response (201):**
```json
{
  "id": "my-machine-v3",
  "affectedActors": 34,
  "strandedTagged": 8
}
```

The 8 stranded actors are now tagged `needs_rescue`. They can be seen in the dashboard under Actor Explorer (filter by status = needs_rescue). They cannot process further events until rescued.

### The confirm token

- Expires in **5 minutes** (default) — regenerated automatically if expired
- One-time use — consumed on the confirming PUT
- Drift-protected: if the number of stranded actors grows by >10% between preview and confirm, the token is invalidated and you get a fresh preview

### Rescuing an actor manually

```bash
curl -X PATCH https://statekeep.161-97-163-210.nip.io/v1/actors/ACTOR_ID \
  -H "x-api-key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "status": "active" }'
```

This resets the actor to `active` and it will be re-evaluated for migration on the next event.

---

## 9. historyPath — Targeting Specific Actors

By default, deploying a new version migrates **all** actors from the parent that can safely migrate. With `historyPath`, you target only actors whose event history matches a specific sequence.

### Use case

You're adding a compliance review step. You only want actors who went through the income verification step (they have `INCOME_VERIFIED` in their history) to get the new compliance_review state. Older actors that skipped income check should stay on the current version.

```bash
curl -X PUT https://statekeep.161-97-163-210.nip.io/v1/definitions \
  -H "x-api-key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "loan-v3",
    "parentId": "loan-v2",
    "historyPath": ["APPLY", "SUBMIT", "INCOME_VERIFIED"],
    "definition": {
      "initial": "idle",
      "states": {
        "idle":               { "on": { "APPLY": "application" } },
        "application":        { "on": { "SUBMIT": "income_check", "CANCEL": "cancelled" } },
        "income_check":       { "on": { "INCOME_VERIFIED": "underwriting", "INCOME_FAILED": "rejected" } },
        "underwriting":       { "on": { "APPROVE": "compliance_review", "REJECT": "rejected" } },
        "compliance_review":  { "on": { "PASS": "approved", "FAIL": "rejected" } },
        "approved":           { "on": { "DISBURSE": "active" } },
        "active":             { "on": { "REPAY": "repaid", "DEFAULT": "defaulted" } },
        "cancelled":  { "type": "final" },
        "rejected":   { "type": "final" },
        "repaid":     { "type": "final" },
        "defaulted":  { "type": "final" }
      }
    }
  }'
```

**How it works:**

StateKeep computes a fingerprint (FNV-1a hash) of each actor's event history and matches it against the `historyPath` sequence. Only actors whose history contains `APPLY → SUBMIT → INCOME_VERIFIED` (in that order, as a subsequence) are eligible for migration to loan-v3. All other loan-v2 actors continue on loan-v2.

### Empty historyPath = wildcard

Omitting `historyPath` (or providing an empty array) means all eligible actors migrate. This is the default.

---

## 10. stateMapping — Renaming States Safely

When you rename a state across versions, actors currently in the old state name would normally be stranded. `stateMapping` lets you declare the rename so actors are remapped instead.

```bash
curl -X PUT https://statekeep.161-97-163-210.nip.io/v1/definitions \
  -H "x-api-key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "ticket-v3",
    "parentId": "ticket-v2",
    "stateMapping": {
      "in_progress": "assigned"
    },
    "definition": {
      "initial": "open",
      "states": {
        "open":      { "on": { "ASSIGN": "assigned", "CLOSE": "closed" } },
        "assigned":  { "on": { "RESOLVE": "resolved", "ESCALATE": "escalated", "CLOSE": "closed" } },
        "escalated": { "on": { "ASSIGN": "assigned", "RESOLVE": "resolved" } },
        "resolved":  { "type": "final" },
        "closed":    { "type": "final" }
      }
    }
  }'
```

Actors in `in_progress` on ticket-v2 will be placed into `assigned` on ticket-v3 — no rescue needed.

**stateMapping vs confirmToken:**
- Use `stateMapping` when you *know* the mapping (renamed state, merged states)
- Use `confirmToken` when actors truly have no equivalent state and must be handled manually

---

## 11. The Dashboard

### Login
Navigate to `https://statekeep.161-97-163-210.nip.io/dashboard/` and enter your credentials.

### Pages

| Page | What it shows |
|---|---|
| **Command Centre** | Live actor counts, recent events feed, system health |
| **Actor Explorer** | Table of all actors — search, filter by status/machine/state, click to inspect |
| **Migration Intel** | Actors currently migrating, rescue count, APV engine status |
| **Machines** | All deployed definition families and versions, actor count per version |
| **Deployment Studio** | Step-by-step wizard to deploy new versions |
| **Scheduled** | Upcoming scheduled events |
| **Webhooks** | Outbound webhook subscriptions |
| **Workers** | Worker pool health |
| **Metrics** | System-level metrics |
| **Settings** | API key management, webhook config |

### Sign Out
Use the "Sign out" button at the bottom of the sidebar. Your API key is cleared from the browser.

### API Explorer
Click **API Explorer** in the sidebar (or navigate to `/api-explorer`). This is a Swagger UI that automatically injects your API key into all requests — no manual authorization needed.

---

## 12. API Quick Reference

**Base URL:** `https://statekeep.161-97-163-210.nip.io`  
**Auth header:** `x-api-key: YOUR_KEY`  
**Content-Type:** `application/json` for all POST/PUT requests

### Definitions

| Method | Path | Description |
|---|---|---|
| `PUT` | `/v1/definitions` | Deploy or update a definition |
| `GET` | `/v1/definitions` | List all definitions (`?limit=50&offset=0`) |
| `GET` | `/v1/definitions/:id` | Get a single definition |

### Actors

| Method | Path | Description |
|---|---|---|
| `POST` | `/v1/actors` | Spawn an actor |
| `POST` | `/v1/actors/bulk` | Bulk spawn (max 500) |
| `GET` | `/v1/actors` | List actors (`?status=active&limit=50`) |
| `GET` | `/v1/actors/:id` | Get a single actor |
| `POST` | `/v1/actors/:id/event` | Send event to actor |
| `GET` | `/v1/actors/:id/events` | Event history (`?limit=20&afterId=0`) |
| `PATCH` | `/v1/actors/:id` | Update actor status (e.g. reset needs_rescue) |

### System

| Method | Path | Description |
|---|---|---|
| `GET` | `/v1/health` | Health check — `{ status: "ok", engine: "real"\|"fallback" }` |
| `GET` | `/v1/health/workers` | Worker heartbeat status (503 if any worker is stale) |
| `GET` | `/v1/health/queues` | Worker priority queue stats — queued/served/avgWait per tier |
| `GET` | `/v1/metrics` | Prometheus-format metrics |
| `POST` | `/v1/auth/login` | Dashboard login — `{ username, password }` → `{ apiKey }` |

### PUT /v1/definitions — full body reference

```json
{
  "id":               "string (required) — unique version ID",
  "definition":       "object (required) — XState v5 machine config",
  "parentId":         "string (optional) — previous version ID",
  "historyPath":      "string[] (optional) — ordered event sequence to match",
  "stateMapping":     "{ oldState: newState } (optional) — rename actors in old states",
  "contextTransform": "{ 'new.path': 'old.path' } (optional) — field renames in actor context during migration",
  "confirmToken":     "string (optional) — UUID from requires_confirmation response",
  "refinement":       "integer (optional, default 1)"
}
```

### POST /v1/actors/:id/event — priority header

Add `X-Priority: high` to route the request to the high-priority worker queue. Default (no header) is `normal`. Background workers use `low` internally. You don't need this for typical application use — it's used by the dashboard for lower-latency reads.

### Event idempotency

Include `"idempotencyKey": "your-unique-key"` in the event body to make the call idempotent. If a request with the same key was already processed, the current actor state is returned without reprocessing. The key must match `[a-zA-Z0-9_\-:.]` and be at most 128 characters.

For the full endpoint reference including webhooks, scheduled events, admin routes, and all response shapes, see `docs/API.md`.
