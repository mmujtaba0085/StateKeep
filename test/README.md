# StateKeep Test Suite

## Quick Start

```bash
# 1. Install deps (builds better-sqlite3 native addon)
npm install

# 2. Build mock engine
make -C mock

# 3. Start server in one terminal
STATEKEEP_ENCRYPTION_KEY=$(openssl rand -hex 32) \
STATEKEEP_DB_PATH=/tmp/sk-test.db \
node src/api/server.js

# 4. Run statechart tests in another terminal (same env vars)
STATEKEEP_DB_PATH=/tmp/sk-test.db npm run test:statechart

# 5. Run everything
npm run test:all
```

---

## Test Levels

| Script                 | What it covers                                    | Server needed |
|------------------------|---------------------------------------------------|---------------|
| `npm run test:unit`    | FFI loader, FNV-1a hash, bigInt utils             | No            |
| `npm run test:properties` | 7 invariants × 100–500 random inputs           | No            |
| `npm run test:c`       | 36 C FFI direct tests against mock engine         | No            |
| `npm run test:integration` | Event flow, auth, concurrency, definition CRUD | Yes           |
| `npm run test:migration` | Migration pipeline, deployment status           | Yes           |
| `npm run test:sc1`     | All valid statecharts (should all pass)           | Yes           |
| `npm run test:sc2`     | Structurally broken statecharts (gap exposure)    | Yes           |
| `npm run test:sc3`     | Logically stuck machines                          | Yes           |
| `npm run test:sc4`     | Migration scenarios (v1→v2→v3 pairs)              | Yes           |
| `npm run test:sc5`     | 50-actor complex + 5-version chains               | Yes           |
| `npm run test:sc6`     | GC + snapshot worker correctness                  | Yes           |
| `npm run test:sc7`     | E2E regression, bundled example files             | Yes           |
| `npm run test:chaos`   | Engine disappearance, corruption, races           | Yes           |
| `npm run test:edge`    | Unicode, 1MB payloads, SQL injection, overflow    | Yes           |
| `STRESS=1 npm run test:stress` | Load: 1000 actors, 5000 events/sec      | Yes           |

---

## Statechart Test Files

```
test/statechart/
├── machines.js       ← Machine catalog (27 definitions across 4 categories)
├── sc1.valid.js      ← 52 tests: valid machines all pass
├── sc2.structural.js ← 24 tests: broken JSON → rejected/documented gaps
├── sc3.stuck.js      ← 28 tests: logically stuck → scenarios expose traps
├── sc4.migration.js  ← Migration pairs A/B/C, hotfix refinement, diff checks
├── sc5.complex.js    ← 50 actors, 5-version chain, 100 parallel, 20 scenarios
├── sc6.workers.js    ← GC eligibility, snapshot correctness, worker isolation
└── sc7.e2e.js        ← Bundled example files, regression matrix, cross isolation
```

### Machine Catalog (`machines.js`)

**Valid machines** — all should load and spawn:
- `VALID_MINIMAL` — 2 states, 1 transition
- `VALID_LINEAR` — 4 states, retry loop
- `VALID_BRANCHING` — 6 states, 3 exit paths
- `VALID_CYCLIC` — 5 states, retry with abort
- `VALID_HIERARCHICAL` — compound states, 4 levels
- `VALID_PARALLEL` — orthogonal regions (payment + shipping)
- `VALID_WITH_ACTIONS` — entry/exit action names (no implementation needed)
- `VALID_MULTI_FINAL` — 3 distinct final states
- `VALID_SELF_TRANSITION` — self-loop state
- `VALID_DEEP` — 4-level hierarchy, cross-level absolute transition
- `VALID_MANY_STATES` — 20-state pipeline
- `VALID_ONBOARDING` — realistic SaaS onboarding flow
- `VALID_CONTEXT_HEAVY` — loan lifecycle with rich context schema
- `COMPLEX_SAAS` + `COMPLEX_SAAS_V2` — compound active state, multi-path

**Migration pairs** — v1/v2 tested together:
- `MIGRATE_A_V1/V2` — additive (new states added, backward-compatible)
- `MIGRATE_B_V1/V2` — renaming (active→paying, suspended→paused — BREAKING)
- `MIGRATE_C_V1/V2` — subtractive (removes states and transitions — BREAKING)

**Stuck machines** — valid JSON, logically broken:
- `STUCK_DEAD_END` — non-final state with no transitions
- `STUCK_UNREACHABLE` — state with no incoming path
- `STUCK_NO_TERMINAL` — machine has no final states
- `STUCK_SELF_LOOP_ONLY` — final state is unreachable via loop
- `STUCK_MISSING_EVENT` — scenario sends wrong event type
- `STUCK_GUARD_NO_IMPL` — guard names without implementations

**Broken machines** — structurally invalid:
- `BROKEN_NO_INITIAL` — missing `initial` field
- `BROKEN_INITIAL_MISSING_TARGET` — `initial` references nonexistent state
- `BROKEN_TRANSITION_TO_NOWHERE` — transition targets ghost state
- `BROKEN_EMPTY_STATES` — `states: {}`
- `BROKEN_NO_STATES` — no `states` field at all
- `BROKEN_PARALLEL_NO_CHILDREN` — parallel with empty regions
- `BROKEN_COMPOUND_NO_INITIAL` — compound state without own `initial`

---

## SC2 Gap Tests — What They Expose

`sc2.structural.js` contains tests labelled `[STORE-GAP]` and `[RUNTIME]` that
document known platform limitations:

| Gap | Description | Tests |
|-----|-------------|-------|
| **STORE-GAP** | `PUT /v1/definitions` accepts any JSON object without XState validation | SC2-B |
| **RUNTIME-GAP** | Invalid definitions may spawn actors with `undefined` stateValue | SC2-C |
| **VALIDATE-SOFT** | XState v5 silently accepts some logically broken machines (empty states, numeric initial) | SC2-A B4/B5 |

These tests pass (they correctly observe current behaviour) — they are NOT expected to fail.
Fixing the gaps would require adding pre-storage validation (call `createMachine` + `createActor` 
before `PUT /v1/definitions` stores anything).

---

## SC3 Gap Tests — Stuck Machine Behaviour

`sc3.stuck.js` tests labelled `[GAP]` document that the validate endpoint has
**no static analysis** for:
- Dead-end states (non-final, no outgoing transitions)
- Unreachable states (no incoming path from initial)
- Machines with no final states
- Self-loop-only machines

XState v5 accepts all of these at machine-creation time. Detection requires
additional static analysis on top of `createMachine()`.

The `[EXPECTED-PASS]` tests verify that once an actor enters these traps,
the system handles them gracefully (no crash, valid state, scenarios report
correct failures).

---

## Running Workers

StateKeep runs several background worker processes alongside the API server.
Start each in a separate terminal (or as a systemd/PM2 service in production):

```bash
# GC worker — archives idle actors, runs SQLite maintenance
node src/workers/gc-worker.js

# Scheduler worker — fires past-due scheduled events with retry backoff
node src/workers/scheduler-worker.js

# Migrate worker — runs batch definition migrations
node src/workers/migrate-worker.js

# Snapshot worker — captures periodic actor state snapshots
node src/workers/snapshot-worker.js

# Metrics worker — records API and FFI performance snapshots
node src/workers/metrics-worker.js

# Webhook worker — delivers pending webhook_deliveries with HMAC signing
node src/workers/webhook-worker.js
```

All workers register a heartbeat row in `worker_heartbeats` and can be monitored
via `GET /v1/health/workers`. A stale worker (last beat > 2 minutes ago) triggers
a 503 response and shows as unhealthy in the dashboard (`/dashboard/workers.html`).

---

## CI Pipeline

```
unit + properties  ──┬──> integration + statechart ──> coverage
                      └──> c-ffi
                      └──> legacy
```

All stages run on Ubuntu 22.04. The `statechart` stage runs SC1–SC7 in order
against a fresh server instance with `libapv-mock.so` (always-stay mode).

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `STATEKEEP_DB_PATH` | Yes | Path for test SQLite database |
| `STATEKEEP_ENCRYPTION_KEY` | Yes | 32-byte hex key for AES-256-GCM |
| `PORT` | No (default 3099) | API server port |
| `STATEKEEP_ENGINE_PATH` | No | Path to `libapv-engine.so` or mock |
| `STRESS` | No | Set to `1` to enable Level 5 load tests |
| `C_TESTS` | No | Set to `1` to include C FFI binary tests |

---

## Requirements

- Node.js ≥ 22 (uses `node:test` built-in runner)
- GCC (for mock engine: `make -C mock`)
- Ubuntu 22.04 or any Linux x64 with glibc ≥ 2.35
- SQLite (included via `better-sqlite3`)
- No Docker required
