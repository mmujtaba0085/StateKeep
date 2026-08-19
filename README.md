# StateKeep

**Host statecharts. Version them. Migrate running actors. Without replay, without downtime, without migration scripts.**

StateKeep is an open-source, self-hosted engine for running stateful workflows as persistent actors. You define a state machine in JSON, deploy it, spawn actor instances, and send events over HTTP. StateKeep handles everything else: state persistence, encryption at rest, event history, version migration, garbage collection, and the safety guarantees that make running stateful logic in production actually safe.

The definition format is compatible with XState v5. The runtime is StateKeep's own.

---

## What Problem This Solves

Every application has state machines. An order is `pending → paid → shipped → delivered`. A user is `trial → active → suspended → churned`. A loan application is `submitted → underwriting → approved → disbursed`. You model these explicitly or implicitly. Either way, once the workflow is live and users are inside it, three problems appear without exception.

**Problem 1: Migration scripts that fail in ways you only find in production.**

Your workflow logic changes. You write a migration script. Staging passes. Production has seven years of edge-case actor states that staging never had. Something fires twice. A side effect re-triggers. You are up at 2am undoing it.

**Problem 2: Old workflow versions you can never fully retire.**

You deploy v3. v1 is still running because some actors have not finished. You cannot shut it down. v4 ships. v1 is still alive. The graveyard of unmaintained workflow versions grows with every release, each one a liability you have to keep compatible.

**Problem 3: Actors silently stranded on versions nobody maintains.**

An actor that did not match migration criteria stays on the old version. Applying old logic. Returning stale state. Nobody notices until a user files a strange support ticket — if they ever do.

StateKeep solves all three. It treats statechart definitions as first-class versioned data and uses a deterministic, fingerprint-based migration engine to route every active actor to exactly the right version — based on the path each actor took, not just where it currently is.

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

No `historyPath` means wildcard: all actors on the parent definition are eligible for this deployment. With `historyPath`, only actors whose current event history exactly matches that sequence are eligible — actors that have processed additional events since are not selected. The `historyPath` is hashed via FNV-1a and registered with the APV engine as the `prefix_hash` for this changepoint. The engine evaluates every actor against this hash during deployment.

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

**Hard errors (400, definition not stored):** `EMPTY_STATES`, `INVALID_INITIAL` (initial references nonexistent state), `INVALID_TRANSITION` (transition targets nonexistent state), `COMPOUND_NO_INITIAL` (compound state has children but no `initial`), `COMPILE_ERROR` (the compiler threw during compilation), `UNDEFINED_INITIAL` (the definition compiled but the initial state resolved to undefined).

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
│           /v1/definitions/validate  /v1/definitions/scenario│
│           /v1/health  /v1/health/workers  /v1/health/queues│
│           /v1/metrics  /v1/webhooks  /dashboard/*         │
│   actorManager: LRU hot registry + workerPool dispatch   │
└────────┬─────────────────────────────┬───────────────────┘
         │                             │
┌────────▼────────────────┐   ┌────────▼──────────────────┐
│   Worker Pool           │   │   SQLite (WAL mode)        │
│   N threads (CPU-1)     │   │                           │
│   Custom interpreter    │   │   actors                  │
│   SPAWN / HYDRATE       │◄──►   definitions             │
│   TERMINATE             │   │   events    (immutable)   │
│   FNV-1a fingerprinting │   │   deployments             │
│   LRU hot registry      │   │   migration_jobs          │
└─────────────────────────┘   │   api_keys                │
                              │   metrics_snapshots       │
┌─────────────────────────┐   │   schema_migrations       │
│   Background Workers    │   └───────────────────────────┘
│                         │
│   migrate-worker        │   ┌───────────────────────────┐
│   poll 500ms            │   │   APV Engine (WASM)       │
│   claim up to 500 jobs  │   │   src/ffi/apv-engine.mjs  │
│   HYDRATE actors to     │   │   (WASM inlined via       │
│   new definitions       │   │    Emscripten)            │
│                         │   │                           │
│   gc-worker             │   │   apv_registry_create/destroy
│   poll 60s              │   │   apv_clock_tick          │
│   archive idle actors   │   │   apv_register_changepoint│
│   vacate prefixes       │◄──►   apv_compute_accessible  │
│                         │   │   apv_actor_started/stopped
│   snapshot-worker       │   └───────────────────────────┘
│   periodic DB snapshots │
│                         │
│   metrics-worker        │
│   capture to DB         │
└─────────────────────────┘
```

**SQLite as the backbone.** The entire operational state lives in one WAL-mode SQLite file. This is a deliberate architectural choice: ACID guarantees with no distributed system, zero external dependencies, directly queryable with SQL, backed up with `cp`, inspectable with any SQLite client. WAL mode allows multiple concurrent readers while a single writer holds the lock, which is sufficient for the access pattern of this system.

**Worker pool.** Actor execution runs in worker threads to avoid blocking the event loop. Each thread manages up to `ACTORS_PER_WORKER` actors using StateKeep's custom interpreter. The LRU hot registry keeps recently-accessed actors in the pool. Cold actors (not recently accessed) are evicted from memory and their state is spilled to SQLite synchronously; they are rehydrated into a thread on next event arrival.

**Priority queue.** Each worker slot holds a four-tier queue: `urgent` (dashboard manual actions — get state, send event, terminate), `high` (dashboard background polling, `X-Priority: high`), `normal` (default API calls), and `low` (background migrate-worker jobs). In burst mode, urgent requests get exclusive access for the first 5 s of continuous load, then fall to one urgent slot per round interleaved with a 3H:2N:1L cycle. Within each tier, per-org round-robin prevents one org's burst from starving others. Queue stats are exposed at `GET /v1/health/queues`.

**Event coalescing.** When a worker slot finishes a job, it looks ahead in the same-org, same-tier queue for consecutive EVENT messages targeting the same actor. Up to 8 are batched into a single `BATCH_EVENTS` dispatch. This reduces inter-thread IPC and lets fingerprint chaining happen in-worker across the batch in a single pass.

**Deferred write buffer.** State updates, events, and migration decisions are collected in an in-process buffer and flushed to SQLite in a single transaction every 50ms. If 200 items accumulate before the timer fires, the buffer flushes immediately. Crash window is at most 50ms of unwritten state.

**Fingerprint chain.** Every event processed by an actor updates its history fingerprint: `fp = fnv1aUpdate(fp, eventType)`. The fingerprint starts from `FNV_OFFSET` (the standard 64-bit FNV-1a offset basis, `0xcbf29ce484222325`). The sentinel `'0'` stored in the database for a freshly spawned actor maps to `FNV_OFFSET` when the chain starts. The computation is identical in the WASM engine and the JavaScript worker.

---

## The APV Engine Contract

The history fingerprint is a standard FNV-1a hash chain: each event updates `fp = fnv1aUpdate(fp, eventType)`. The fingerprint accumulates incrementally — processing an event is a single hash update, not a history scan. Evaluation at migration time is a single hash comparison per actor per deployment. The fingerprint computation is in the open-source worker code and is identical to the WASM engine.

The APV evaluation engine — the part that maintains the changepoint graph and answers routing queries — ships as a compiled WASM binary (`src/ffi/apv-engine.mjs`). The source is proprietary while we evaluate IP protection. The full migration capability is available on day one.

StateKeep treats the APV WASM engine as an oracle. It does not attempt to understand how the engine makes routing decisions internally. The contract is defined by the six function groups exported from `apv-engine.mjs`.

`apv_clock_tick` returns a global monotonic counter. Every definition deployment and every actor spawn is stamped with a tick value. This is the APV logical time — independent of wall clock time.

`apv_register_changepoint(reg, t_star, prefix_hash, refinement, child_def_id)` registers that at time `t_star`, actors whose history fingerprint matches `prefix_hash` should be routed to `child_def_id`. Called once per `PUT /v1/definitions`. `prefix_hash = 0n` is the wildcard; `prefix_hash = computeHistoryHash(historyPath)` restricts to the qualifying path.

`apv_compute_accessible(reg, current_prefix_hash, actor_logical_time, current_time, out_buf, out_size)` answers: given this actor's fingerprint and birth tick, is there a registered changepoint that applies? Called once per active actor during deployment evaluation. Returns 1 with the target definition ID written into `out_buf` if a changepoint matches, 0 if the actor should stay.

`apv_actor_started(reg, t_star, prefix_hash)` and `apv_actor_stopped(reg, t_star, prefix_hash)` maintain the engine's internal count of how many actors are live at each changepoint. This drives GC safety — the engine will not prune a changepoint that still has live actors.

`apv_vacate_prefix(reg, t_star, prefix_hash)` explicitly declares that no future actor will carry a particular prefix at a particular time, allowing the engine to prune that subtree of its changepoint graph.

If `apv-engine.mjs` is absent or fails to load, StateKeep replaces it with a JS fallback where `computeAccessible` always returns `null` (stay) and all other functions are no-ops or identity. The rest of the system is completely unaffected.

---

## Market Position

**Temporal** solves durability brilliantly. Durable async functions, compensating transactions, complex branching — for code-heavy workflows it is genuinely the right tool. But the version is the code version. Changing a running workflow means versioning your functions, not your definition. Old worker processes stay alive until every workflow they own completes, because you cannot force an in-flight function to jump versions. Problems 2 and 3 above are yours to manage. Temporal has no built-in primitives for either.

**Inngest** solves event-driven pipelines with minimal infrastructure. Zero cluster to manage, excellent developer experience, built-in retry and scheduling. But there is no explicit state machine model and no versioned definition concept. A developer who wants a state machine builds one inside a function. Problems 1, 2, and 3 are fully in your hands.

**XState** gives you the state machine model and a rich ecosystem for modeling stateful logic. It is an excellent library. But it is a library, not infrastructure. Persistence, actor lifecycle, version management, and migration routing are all still your responsibility. What you would build on top of XState to make it production-safe for long-running actors — that is what StateKeep is.

**StateKeep** treats the statechart definition as the primary unit of versioning. State is an explicit named value in a database. The definition that produced it is a versioned record with a parent pointer. The event history that produced it is an immutable log. The combination of these three enables path-based migration: two actors in the same state receive different routing decisions in the same deployment if they arrived by different paths. Both outcomes are mathematically correct.

Use Temporal when your workflow is code and replay is a natural fit. Use Inngest when you want zero infrastructure for event-driven pipelines. Use StateKeep when the workflow definition is the product — when it needs to be versioned as data, migrated surgically across live actors, and audited as a first-class database table rather than a replay journal.

---

## Quick Start

### Docker (recommended)

```bash
# 1. Generate required secrets
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# 2. Configure environment
cp .env.example .env
# Edit .env: set STATEKEEP_ENCRYPTION_KEY, STATEKEEP_ADMIN_KEY, STATEKEEP_API_KEY

# 3. Start
docker compose up -d

# 4. Verify
curl http://localhost:3001/v1/health
# → {"status":"ok","engine":"wasm","db":"ok"}

# Dashboard: http://localhost:3001/dashboard/
```

### Manual (Node.js)

```bash
# Install dependencies (Windows: run from PowerShell, not WSL)
npm install

# Configure environment
cp .env.example .env
# Edit .env: set STATEKEEP_ENCRYPTION_KEY, STATEKEEP_ADMIN_KEY, STATEKEEP_API_KEY

# Start server and workers
node --env-file=.env src/api/server.js &
node --env-file=.env src/workers/migrate-worker.js &
node --env-file=.env src/workers/scheduler-worker.js &
node --env-file=.env src/workers/gc-worker.js &
node --env-file=.env src/workers/snapshot-worker.js &
node --env-file=.env src/workers/metrics-worker.js &
```

**Get your API key:**

Set `STATEKEEP_API_KEY=sk_live_<your-key>` in `.env` before the first start — the server seeds it into the database automatically. Or, after the server has started once, generate a new key with:

```bash
node --env-file=.env gen-key.mjs my-key
# → API key "my-key" created (save this — shown once):
# → sk_live_...
```

Use the key in the `x-api-key` header for all API calls.

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
| `STATEKEEP_ENGINE_PATH` | No | — | Path override for the APV WASM engine module (`apv-engine.mjs`). Ships pre-built in `src/ffi/` — no separate installation required. Override only if rebuilding from source. |
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

## Windows Setup

StateKeep runs natively on Windows (no WSL required). The only requirement is
that `npm install` must be run from **Windows PowerShell or Command Prompt**,
not from a WSL shell. This ensures `better-sqlite3` downloads the correct
Windows prebuilt binary instead of the Linux one.

```powershell
# In Windows PowerShell — run once after cloning
npm install

# Generate the encryption key (replaces `openssl rand -hex 32`)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# Copy and edit .env
copy .env.example .env
# Set STATEKEEP_ENCRYPTION_KEY to the value from the command above

# Start the server
node --env-file=.env src/api/server.js
```

If you previously ran `npm install` in WSL (you'll see `ERR_DLOPEN_FAILED` on
startup), rebuild the native module from PowerShell:

```powershell
npm run rebuild
```

**Running tests on Windows:**

```powershell
# Hot-path compiler / interpreter / registry tests (all cross-platform)
npm run test:hot-path

# Full statechart suite SC1–SC9 (starts server automatically)
npm run test:statechart

# Individual suite
npm run test:sc1
```

Tests that require the C FFI mock or bash scripts (`test:all`, `test:c`)
still need WSL on Windows. The `test:statechart` and `test:hot-path` scripts
are fully cross-platform.

---

## Running Tests

```bash
# Unit tests — no server or DB required
npm run test:unit
node --test test/statechart/sc9.unit.js   # migration routing unit tests

# Property-based invariant tests — no server or DB required
npm run test:properties

# Note: the C FFI test target (test:c) is not available in the open-source release.
# The APV engine WASM binary (apv-engine.mjs) is built via: make wasm -C src/ffi

# Full statechart test suite SC1–SC9 (server required)
npm run test:statechart

# Full suite (all levels)
npm run test:all

# With real APV engine (WASM binary must be present at src/ffi/apv-engine.mjs)
npm run test:all

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

## API Reference

Full endpoint documentation covering all routes, request/response shapes, error codes, and the priority queue header is in [`docs/API.md`](docs/API.md).

For a step-by-step integration tutorial with curl examples, see [`docs/getting-started.md`](docs/getting-started.md).

For backend developers integrating StateKeep into their apps, see [`docs/developer-guide.md`](docs/developer-guide.md).

---

## Production Deployment

Full instructions in `docs/deployment.md`. The minimal checklist:

1. Set `STATEKEEP_ENCRYPTION_KEY` to 32 cryptographically random bytes (hex-encoded).
2. Put the SQLite file on a volume with Litestream continuous replication.
3. Run the API server and all five worker processes under systemd or PM2. Workers are safe to restart independently.
4. Put Caddy or nginx in front of the API server for TLS termination.
5. Back up the SQLite file with `PRAGMA wal_checkpoint(FULL)` before copying.

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

---

## License

StateKeep is licensed under [Apache 2.0 with the Commons Clause](LICENSE).

You are free to use, modify, and self-host StateKeep for any purpose. Selling StateKeep — or any modified version of it — as a hosted service or commercial product requires a separate agreement.

For commercial licensing: [mmujtaba0085@gmail.com](mailto:mmujtaba0085@gmail.com)
