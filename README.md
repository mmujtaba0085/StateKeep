# StateKeep

**Host statecharts. Version them. Migrate running actors. Without replay, without downtime, without migration scripts.**

StateKeep is an open-infrastructure platform that runs XState v5 statecharts as long-lived, persistent actors over HTTP. You upload a JSON machine definition, spawn actors against it, and send events. StateKeep handles everything else: state persistence, encryption at rest, event history, version migration, garbage collection, and the safety guarantees that make production deployments of stateful logic possible.

---

## What Problem This Solves

Every application has state machines. An order is `pending → paid → shipped → delivered`. A user is `trial → active → suspended → churned`. A loan application is `submitted → underwriting → approved → disbursed`. You model these explicitly or you model them implicitly in a mess of database flags and boolean columns. Either way, two hard problems always appear.

**Problem 1: The state machine changes after customers are already using it.**

You realise the loan flow needs an income verification step between document collection and approval. You have 40,000 active applications. You cannot replay them. You cannot restart them. You need the new step to apply to the right applicants — those who paid the verification fee — while applicants who waived the fee continue on the old flow. Writing a migration script to move 40,000 rows across two versions of your business logic, without re-triggering any side effects, is the kind of work that causes 2 am incidents.

**Problem 2: The state machine needs to be the product, not just the implementation.**

If you are building a platform where customers configure their own workflows — an insurance company defining claim lifecycles, a bank defining loan workflows, a SaaS company defining onboarding funnels — you cannot deploy a new version of your own application every time a customer changes their flow. The workflow definition needs to be data. It needs to be versioned. Running instances need to migrate to new versions without the developer writing any code.

StateKeep solves both problems. It treats statechart definitions as first-class versioned entities, and uses a proprietary migration engine to route running actors to new versions based on the path each actor took through the old version — not just where they currently are.

---

## Key Capabilities

### Actor Hosting

Upload an XState v5 machine definition via `PUT /v1/definitions`. Spawn actor instances via `POST /v1/actors`. Send events via `POST /v1/actors/:id/event`. The current state, full context, and complete event history are persisted to SQLite after every transition. Actors survive server restarts, crashes, and deployments with no data loss.

Actors run inside Node.js worker threads with an LRU hot registry. Frequently-accessed actors stay warm in memory. Idle actors spill to SQLite and are rehydrated on demand. The design scales to hundreds of thousands of active actors on a single VPS with no external dependencies.

### Version Migration Without Replay

When you deploy a new definition version with a `parentId`, the APV engine evaluates every active actor against the new version. The decision is based on the actor's history fingerprint — a FNV-1a hash of every event type the actor has processed, in order. The engine compares this fingerprint against the `historyPath` you registered with the deployment.

If the actor's history contains the qualifying path, the actor migrates to the new version, carrying its full context, without restarting, without re-entering any data, without re-firing any side effects.

If the actor's history does not contain the qualifying path, the actor stays on its current version and continues working normally.

Two actors on the same current state, having reached it by different paths, receive different routing decisions in the same deployment. Both outcomes are correct.

### historyPath Deployments

```json
{
  "id": "loan-v2",
  "parentId": "loan-v1",
  "definition": { "...": "..." },
  "historyPath": ["START_APPLICATION", "SUBMIT_PERSONAL_INFO", "PAY_FEE"]
}
```

No `historyPath` means wildcard: all actors on the parent definition are eligible for this deployment. With `historyPath`, only actors whose event sequence contains those events in that order are eligible. The `historyPath` is hashed via FNV-1a and registered with the APV engine as the `prefix_hash` for this changepoint. The engine evaluates every actor against this hash during deployment.

### Stranded Actor Protection

If a new definition removes states that are currently occupied by active actors, StateKeep refuses to proceed silently. The first PUT without a `confirmToken` returns a preview:

```json
{
  "status": "requires_confirmation",
  "strandedActors": [
    { "currentState": "active",    "count": 12 },
    { "currentState": "suspended", "count": 3  }
  ],
  "safeActors": 45,
  "confirmToken": "a1b2c3d4-...",
  "expiresIn": 300,
  "message": "15 actors are in states removed by this version..."
}
```

Nothing is written to the database. Re-submit the same body with `"confirmToken": "<token>"` to proceed. The stranded actors are tagged `needs_rescue` and return 409 on any event until a rescue deployment provides a forward path. The token expires in 5 minutes. If the stranded actor count grows by more than 10% between preview and confirm, the token is invalidated and a fresh preview is required.

### Rescue Deployments

When a buggy version has already received actors, deploy a rescue version targeting it:

```json
{
  "id": "loan-v2-rescue",
  "parentId": "loan-v2-buggy",
  "definition": { "...": "..." },
  "historyPath": ["START_APPLICATION", "SUBMIT_PERSONAL_INFO", "PAY_FEE", "TRIGGER_BUG"]
}
```

Only actors whose history includes the buggy path migrate to the fix. All other actors are unaffected. No rollback. No system-wide freeze. Forward only.

### Static Analysis Before Storage

Every definition is validated against two layers before any database write.

**Hard errors (400, definition not stored):** `EMPTY_STATES`, `INVALID_INITIAL` (initial references nonexistent state), `INVALID_TRANSITION` (transition targets nonexistent state), `COMPOUND_NO_INITIAL` (compound state has children but no `initial`), `XSTATE_ERROR` (XState threw during construction), `UNDEFINED_INITIAL` (XState accepted the definition but the machine started with `value = undefined`, the deferred-throw gap).

**Soft warnings (201, definition stored, warnings in response):** `DEAD_END_STATE` (non-final state with no outgoing transitions), `UNREACHABLE_STATE` (no path from initial), `NO_TERMINAL_STATE` (no final states in the machine).

### Scenario Testing

Run event sequences against a machine definition without spawning persistent actors:

```json
POST /v1/definitions/scenario
{
  "definition": { "...": "..." },
  "scenarios": [
    {
      "name": "paid applicant completes",
      "initialContext": { "applicantId": "usr-001" },
      "events": ["START_APPLICATION", "SUBMIT_PERSONAL_INFO", "PAY_FEE", "SUBMIT_DOCS"],
      "expectedStates": ["started", "info_submitted", "awaiting_docs", "done"],
      "expectDone": true
    }
  ]
}
```

`expectDone` is enforced in both directions: `true` fails if the machine is not in a final state after all events, `false` fails if the machine unexpectedly reaches a final state. Events can be plain strings or `{ "type": "EVENT_NAME" }` objects. Both forms are equivalent.

### Encryption at Rest

Actor context is encrypted with AES-256-GCM before every SQLite write. Each write generates a fresh random IV so identical contexts produce different ciphertext. The key is set via `STATEKEEP_ENCRYPTION_KEY` and never logged.

### Garbage Collection

The GC worker runs every 60 seconds and archives actors idle for more than 24 hours. Each archived actor is serialised to a gzip-compressed JSON file in `STATEKEEP_DATA_DIR/archives/`, the DB row is marked `archived`, and `apv_actor_stopped` + `apv_vacate_prefix` are called so the engine can prune the internal changepoint graph for that actor's prefix.

### System Event Types

StateKeep writes the following internal event types to an actor's event history. These events are never triggered by client calls and cannot be replayed.

| Event Type | Emitted By | Description |
|---|---|---|
| `SPAWN` | Actor worker | Written when an actor is first created via `POST /v1/actors`. |
| `MIGRATED` | Migrate worker | Written when an actor successfully migrates to a new definition version. |
| `MIGRATION_FAILED` | Migrate worker | Written when migration routing fails (actor enters `needs_rescue` status). |
| `SCHEDULED_EVENT_FIRED` | Scheduler worker | Written when a scheduled event fires and the target event is delivered to the actor. |

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                     Client (HTTP / WS)                  │
└──────────────────────────┬──────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────┐
│                   Fastify API Server (:3001)             │
│   preHandler: auth (X-API-Key) → rate-limit             │
│   routes: /v1/actors  /v1/definitions  /v1/keys          │
│           /v1/definitions/validate                       │
│           /v1/definitions/scenario                       │
│           /v1/metrics  /v1/health  /dashboard/*          │
│   actorManager: LRU hot registry + workerPool dispatch   │
└────────┬─────────────────────────────┬───────────────────┘
         │                             │
┌────────▼────────────────┐   ┌────────▼──────────────────┐
│   Worker Pool           │   │   SQLite (WAL mode)        │
│   N threads (CPU-1)     │   │                           │
│   XState v5 actors      │   │   actors                  │
│   createMachine()       │◄──►   definitions             │
│   actor.send()          │   │   events    (immutable)   │
│   FNV-1a fingerprinting │   │   deployments             │
│   LRU hot registry      │   │   migration_jobs          │
└─────────────────────────┘   │   api_keys                │
                              │   metrics_snapshots       │
┌─────────────────────────┐   │   schema_migrations       │
│   Background Workers    │   └───────────────────────────┘
│                         │
│   migrate-worker        │   ┌───────────────────────────┐
│   poll 500ms            │   │   libapv-engine.so        │
│   claim up to 100 jobs  │   │   (C, koffi dlopen)       │
│   HYDRATE actors to     │   │                           │
│   new definitions       │   │   apv_registry_create/destroy
│                         │   │   apv_clock_tick          │
│   gc-worker             │   │   apv_register_changepoint│
│   poll 60s              │   │   apv_compute_accessible  │
│   archive idle actors   │   │   apv_actor_started/stopped
│   vacate prefixes       │◄──►   apv_vacate_prefix       │
│                         │   │   apv_fnv1a_{init,update,final}
│   snapshot-worker       │   └───────────────────────────┘
│   periodic DB snapshots │
│                         │
│   metrics-worker        │
│   capture to DB         │
└─────────────────────────┘
```

**SQLite as the backbone.** The entire operational state lives in one WAL-mode SQLite file. This is a deliberate architectural choice: ACID guarantees with no distributed system, zero external dependencies, directly queryable with SQL, backed up with `cp`, inspectable with any SQLite client. WAL mode allows multiple concurrent readers while a single writer holds the lock, which is sufficient for the access pattern of this system.

**Worker pool.** Actor execution runs in worker threads to avoid blocking the event loop. Each thread manages up to `ACTORS_PER_WORKER` XState actor instances. The LRU hot registry keeps recently-accessed actors in the pool. Cold actors (not recently accessed) are evicted from memory and their state is spilled to SQLite synchronously; they are rehydrated into a thread on next event arrival.

**Fingerprint chain.** Every event processed by an actor updates its history fingerprint: `fp = fnv1aUpdate(fp, eventType)`. The fingerprint starts from `FNV_OFFSET` (the standard 64-bit FNV-1a offset basis, `0xcbf29ce484222325`). The sentinel `'0'` stored in the database for a freshly spawned actor maps to `FNV_OFFSET` when the chain starts. The computation is identical in the C engine and the JavaScript worker.

---

## The APV Engine Contract

StateKeep treats `libapv-engine.so` as an oracle. It does not attempt to understand how the engine makes routing decisions internally. The contract is defined by the six function groups in `apv-engine.h`.

`apv_clock_tick` returns a global monotonic counter. Every definition deployment and every actor spawn is stamped with a tick value. This is the APV logical time — independent of wall clock time.

`apv_register_changepoint(reg, t_star, prefix_hash, refinement, child_def_id)` registers that at time `t_star`, actors whose history fingerprint matches `prefix_hash` should be routed to `child_def_id`. Called once per `PUT /v1/definitions`. `prefix_hash = 0n` is the wildcard; `prefix_hash = computeHistoryHash(historyPath)` restricts to the qualifying path.

`apv_compute_accessible(reg, current_prefix_hash, actor_logical_time, current_time, out_buf, out_size)` answers: given this actor's fingerprint and birth tick, is there a registered changepoint that applies? Called once per active actor during deployment evaluation. Returns 1 with the target definition ID written into `out_buf` if a changepoint matches, 0 if the actor should stay.

`apv_actor_started(reg, t_star, prefix_hash)` and `apv_actor_stopped(reg, t_star, prefix_hash)` maintain the engine's internal count of how many actors are live at each changepoint. This drives GC safety — the engine will not prune a changepoint that still has live actors.

`apv_vacate_prefix(reg, t_star, prefix_hash)` explicitly declares that no future actor will carry a particular prefix at a particular time, allowing the engine to prune that subtree of its changepoint graph.

If `libapv-engine.so` is absent or fails to load, StateKeep replaces it with a JS fallback where `computeAccessible` always returns `null` (stay) and all other functions are no-ops or identity. The rest of the system is completely unaffected.

---

## Market Position

The three platforms most often compared to StateKeep are Temporal, Cadence (Temporal's predecessor), and Inngest. The comparison is worth making precisely because the surface similarity — all four handle long-running stateful processes — hides a fundamental difference in what each system treats as the primary unit of work.

**Temporal and Cadence** treat code as the primary unit. You write an async function. Temporal makes that function durable by recording a history of every decision it makes and replaying the function from scratch on every worker restart, skipping already-completed steps. State is the accumulated result of the function's execution history. This model is extremely powerful for complex workflows with branching logic, compensating transactions, and external API calls where you want the reliability of a state machine without having to define one explicitly. Its limitations: the replay model means side effects must be carefully isolated or they re-fire, local development requires running a full Temporal cluster, and the workflow version is the code version — changing a running workflow requires careful versioning of the code itself, not the definition.

**Inngest** treats events as the primary unit. An event triggers a function; that function runs in steps that can sleep and wait for more events. The system provides retry, backoff, and scheduling. There is no explicit state machine model. A developer who wants a state machine in Inngest builds one inside a function using a switch statement. The state lives in function variables. There is no migration concept because there is no versioned definition.

**StateKeep** treats the statechart definition as the primary unit. State is an explicit, named value stored in a database. The definition that produced that state is a versioned record with a parent pointer. The event history that produced that state is an immutable log. The combination of these three — current state, versioned definition, event history — enables the capability that defines StateKeep: path-based migration, where two actors on the same state can receive different migration decisions because they arrived by different paths.

The practical consequences of this difference:

For a developer building a background job pipeline, Temporal is the better choice. The workflow is code, the steps are clear, and replay is a natural fit.

For a developer building event-driven microservices with zero infrastructure, Inngest is the better choice. The developer experience is excellent and the deployment model is simple.

For a platform builder whose customers are the ones defining workflows — loan officers configuring approval flows, operations teams configuring SLA pipelines, insurance adjusters configuring claim workflows — StateKeep is the right choice. The definitions are data, not code. New versions can be deployed to production without a code deployment. Running instances migrate based on their history, not their current state. The audit log is a first-class database table, not an internal replay journal.

---

## Quick Start

```bash
# Install dependencies
npm install

# Build the development mock engine
make -C mock

# Configure environment
cp .env.example .env
# Edit .env: STATEKEEP_ENCRYPTION_KEY=$(openssl rand -hex 32)
#            STATEKEEP_DB_PATH=/var/lib/statekeep/db.sqlite

# Start server and workers
node src/api/server.js &
node src/workers/migrate-worker.js &
node src/workers/scheduler-worker.js &
node src/workers/gc-worker.js &
node src/workers/snapshot-worker.js &
node src/workers/metrics-worker.js &
```

**Create an API key:**

```bash
curl -sX POST http://localhost:3001/v1/keys \
  -H "Content-Type: application/json" \
  -d '{"label":"dev","tier":"pro"}'
```

**Deploy a definition:**

```bash
curl -X PUT http://localhost:3001/v1/definitions \
  -H "X-API-Key: sk_<keyId>_<secret>" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "order-v1",
    "definition": {
      "id": "order",
      "initial": "pending",
      "states": {
        "pending":   { "on": { "PAY": "paid",  "CANCEL": "cancelled" } },
        "paid":      { "on": { "SHIP": "shipped" } },
        "shipped":   { "on": { "DELIVER": "delivered" } },
        "delivered": { "type": "final" },
        "cancelled": { "type": "final" }
      }
    }
  }'
```

**Spawn and drive an actor:**

```bash
ACTOR=$(curl -sX POST http://localhost:3001/v1/actors \
  -H "X-API-Key: sk_<keyId>_<secret>" \
  -H "Content-Type: application/json" \
  -d '{"definitionId":"order-v1","initialContext":{"orderId":"ord-123"}}' \
  | jq -r .id)

curl -X POST "http://localhost:3001/v1/actors/$ACTOR/event" \
  -H "X-API-Key: sk_<keyId>_<secret>" \
  -H "Content-Type: application/json" \
  -d '{"type":"PAY"}'
```

**Deploy a new version with path-based routing:**

```bash
# Only actors who paid (not cancelled) are eligible for v2
curl -X PUT http://localhost:3001/v1/definitions \
  -H "X-API-Key: sk_<keyId>_<secret>" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "order-v2",
    "parentId": "order-v1",
    "historyPath": ["PAY"],
    "definition": {
      "id": "order",
      "initial": "pending",
      "states": {
        "pending":   { "on": { "PAY": "paid", "CANCEL": "cancelled" } },
        "paid":      { "on": { "SHIP": "shipped" } },
        "shipped":   { "on": { "DELIVER": "review" } },
        "review":    { "on": { "APPROVE": "delivered", "DISPUTE": "disputed" } },
        "delivered": { "type": "final" },
        "disputed":  { "type": "final" },
        "cancelled": { "type": "final" }
      }
    }
  }'
```

---

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `STATEKEEP_DB_PATH` | Yes | — | SQLite database file path |
| `STATEKEEP_ENCRYPTION_KEY` | Yes | — | 64-char hex (32 bytes) for AES-256-GCM context encryption |
| `STATEKEEP_ENGINE_PATH` | No | — | Path to `libapv-engine.so`. Absent = fallback mode (no migration) |
| `PORT` | No | `3001` | Fastify API server port |
| `LOG_DIR` | No | `./logs` | Directory for daily rotating log files |
| `LOG_LEVEL` | No | `info` | Pino log level (`trace`, `debug`, `info`, `warn`, `error`) |
| `STATEKEEP_DATA_DIR` | No | `/opt/statekeep/data` | Root directory for GC archives |
| `HOT_REGISTRY_SIZE` | No | `10000` | Maximum actors to keep warm in the LRU registry |
| `IDLE_TIMEOUT_SECONDS` | No | `300` | Seconds of inactivity before an actor is spilled to SQLite |
| `CONFIRM_TOKEN_TTL_MS` | No | `300000` | Stranded-actor confirm token lifetime in milliseconds (5 min) |
| `CONFIRM_DRIFT_THRESHOLD` | No | `0.10` | Fractional actor count increase that invalidates a confirm token |
| `STATEKEEP_ADMIN_KEY` | Yes | — | Master key required for org management and admin endpoints (`x-admin-key` header) |
| `SCHEDULER_POLL_INTERVAL` | No | `5000` | Milliseconds between scheduler-worker polls for due events |
| `SCHEDULED_EVENT_RETENTION_DAYS` | No | `30` | Days to retain terminal (`fired`, `failed`, `cancelled`) scheduled event rows |
| `NODE_ENV` | No | — | Set to `production` to enable log file rotation |

---

## Running Tests

```bash
# Unit tests — no server or DB required
npm run test:unit
node --test test/statechart/sc9.unit.js   # migration routing unit tests

# Property-based invariant tests — no server or DB required
npm run test:properties

# C FFI tests (requires: make -C mock)
npm run test:c

# Full statechart test suite SC1–SC9 (server required)
npm run test:statechart

# Full suite (all levels)
npm run test:all

# With real APV engine
STATEKEEP_ENGINE_PATH=/path/to/libapv-engine.so npm run test:all

# Load tests (resource intensive)
STRESS=1 npm run test:stress
```

---

## SDK

```bash
npm install @statekeep/sdk
```

```js
import { createClient } from '@statekeep/sdk';

const sk = createClient({ baseUrl: 'https://your-statekeep-instance.com', apiKey: 'sk_...' });

await sk.deploy('order-v1', { id: 'order', initial: 'pending', states: {
  pending:   { on: { PAY: 'paid', CANCEL: 'cancelled' } },
  paid:      { on: { SHIP: 'shipped' } },
  shipped:   { type: 'final' },
  cancelled: { type: 'final' },
}});

const actor = await sk.spawn('order-v1', { orderId: 'ord-001' });
const state = await sk.send(actor.actorId, 'PAY');
console.log(state.stateValue); // 'paid'
```

See [`sdk/README.md`](sdk/README.md) for full SDK documentation.

---

## CLI

```bash
# Push a machine definition file to StateKeep
statekeep push order.machine.js --url https://your-instance.com --key sk_...

# Watch a directory and auto-push on file changes (dev mode)
statekeep dev --url http://localhost:3001 --key sk_...

# Preview migration impact before deploying a new version
statekeep preview order-v2.machine.js --parent order-v1 --url https://your-instance.com --key sk_...
```

---

## Production Deployment

Full instructions in `docs/deployment.md`. The minimal checklist:

1. Set `STATEKEEP_ENCRYPTION_KEY` to 32 cryptographically random bytes (hex-encoded).
2. Put the SQLite file on a volume with Litestream continuous replication.
3. Run the API server and all five worker processes under systemd or PM2. Workers are safe to restart independently.
4. Put Caddy or nginx in front of the API server for TLS termination.
5. Back up the SQLite file with `PRAGMA wal_checkpoint(FULL)` before copying.

```bash
sudo bash scripts/install.sh
```

---

## Scaling

StateKeep uses **SQLite in WAL mode** as its sole datastore. This is an intentional design choice: SQLite provides ACID guarantees, zero operational overhead, and excellent single-node read throughput.

### Practical limits (single node, NVMe SSD)

| Metric                        | Practical ceiling      |
|-------------------------------|------------------------|
| Write throughput (WAL mode)   | ~5,000 writes/second   |
| Active actors in hot registry | 10,000–100,000 (RAM)   |
| Total actors (cold, on disk)  | Millions               |
| Migration jobs per second     | ~500 (migrate-worker)  |
| API request throughput        | ~2,000 req/s           |

WAL mode allows one writer and many concurrent readers. The single-writer constraint means sustained write bursts above ~5k/s will queue and add latency. Tune `HOT_REGISTRY_SIZE` to keep the hottest actors in RAM and reduce write frequency.

### When to move beyond SQLite

Consider a Postgres adapter (not yet available — see roadmap) when:

- Sustained write throughput exceeds 3,000/s for more than a few minutes
- You need multi-process or multi-host replication (e.g., active-active across regions)
- WAL file grows beyond ~500 MB despite regular checkpointing

### Mitigation strategies (before needing Postgres)

1. **Increase `HOT_REGISTRY_SIZE`** — more actors cached in RAM means fewer SQLite writes per request.
2. **Increase `IDLE_TIMEOUT_SECONDS`** — evict actors to DB less aggressively.
3. **Tune `ACTORS_PER_WORKER`** — more actors per thread reduces IPC overhead.
4. **Schedule `PRAGMA wal_checkpoint(TRUNCATE)`** during off-peak hours to prevent WAL growth.
5. **Deploy on NVMe SSD** — WAL write latency is I/O-bound; HDD is unsuitable for production.

The SQLite WAL ceiling is a known, documented constraint of this deployment model — it is not a bug and will not be silently worked around. When you hit it, the right move is a purpose-built distributed actor store.
