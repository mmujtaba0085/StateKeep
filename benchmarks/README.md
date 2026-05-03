# StateKeep Migration Benchmark

Measures and compares 5 approaches to statechart migration routing correctness and speed.

The benchmark deploys a "loan application" state machine that adds an income-verification
step for actors who paid a fee. The routing challenge: **both actor groups end in the
identical state `awaiting_docs`** — so any approach that routes by current state alone
silently mis-routes half the actors.

---

## Quick Start

```bash
# 1. Start StateKeep server with all workers
cd ..
npm start &
node src/workers/migrate-worker.js &   # required for approach 1

# 2. Install benchmark dependencies
cd benchmarks
npm install

# 3. Configure credentials
cp .env.example .env
# Edit .env — fill in STATEKEEP_URL, STATEKEEP_ADMIN_KEY, STATEKEEP_API_KEY,
# STATEKEEP_DB_PATH, STATEKEEP_ENCRYPTION_KEY

# 4. Run all 5 approaches
npm run benchmark

# 5. Or run the interactive live demo
npm run demo
```

---

## What Is Being Measured

### The Scenario

A loan application machine (V1) has a branch at `info_submitted`:
- `PAY_FEE` → `awaiting_docs` (actor paid the application fee)
- `WAIVE_FEE` → `awaiting_docs` (fee was waived)

V2 adds an income verification step **only for actors who paid**:
- `PAY_FEE` → `income_verify` → `awaiting_docs`
- `WAIVE_FEE` → `awaiting_docs` (unchanged)

### The Two Actor Groups

| Group | Event path                      | State after path | Should migrate? |
|-------|---------------------------------|------------------|-----------------|
| A     | START → SUBMIT_INFO → PAY_FEE   | `awaiting_docs`  | **YES** (paid)  |
| B     | START → SUBMIT_INFO → WAIVE_FEE | `awaiting_docs`  | **NO** (waived) |

**Both groups are in the identical state `awaiting_docs`.**

Any approach that routes by current state alone cannot distinguish A from B.
It will migrate all actors (50% wrong) or migrate none (50% wrong).

### Correct Totals

- Should migrate: N/2 (group A — paid fee)
- Should stay on v1: N/2 (group B — waived fee)

---

## The Five Approaches

| # | Approach            | How it identifies eligible actors           | DB access needed |
|---|---------------------|---------------------------------------------|------------------|
| 1 | APV Engine          | `historyPath` in PUT /v1/definitions        | No               |
| 2 | Full-table SQL      | None — all actors updated unconditionally   | Yes              |
| 3 | Context field       | Reads `context.paid` flag from encrypted DB | Yes              |
| 4 | Event history SQL   | Finds actors with PAY_FEE after SUBMIT_INFO | Yes              |
| 5 | XState resolveState | Calls `resolveState()` per actor, fallback  | Yes              |

### Approach 1 — APV Engine (`historyPath`)

```js
await PUT('/v1/definitions', {
  id:          'loan-v2',
  parentId:    'loan-v1',
  definition:  LOAN_V2,
  historyPath: ['START', 'SUBMIT_INFO', 'PAY_FEE'],
});
```

StateKeep's APV engine hashes this path (FNV-1a chain) and compares it against each
actor's accumulated history fingerprint. Only actors that processed exactly these events
in this order are eligible. Zero lines of migration logic to write.

**Expected: 100% accuracy, fastest developer experience.**

### Approach 2 — Full-table SQL (naive)

A developer writes a 5-line migration script that opens SQLite and runs:
```sql
UPDATE actors SET definition_id = 'loan-v2' WHERE definition_id = 'loan-v1';
```
No filtering. All actors moved to v2. Fast but catastrophically wrong.

**Expected: 50% accuracy — Group B (waived fee) wrongly migrated.**

Requires `STATEKEEP_DB_PATH`.

### Approach 3 — Context field inspection

A migration script reads `actors.context_json` from SQLite, decrypts each blob
(AES-256-GCM, requires `STATEKEEP_ENCRYPTION_KEY`), checks `context.paid === true`,
then directly updates `actors.definition_id` in SQLite.

Accuracy is 100% **only if** `context.paid` was set consistently on every actor.
In production: silently wrong if any actor was created before the flag was introduced.

Requires `STATEKEEP_DB_PATH` and `STATEKEEP_ENCRYPTION_KEY`.

### Approach 4 — Event history SQL query

A migration script queries the `events` table for actors with `PAY_FEE` after
`SUBMIT_INFO` (correlated subquery on `tick`). Event history is immutable —
no missed flags. But the query is `O(N × E)` and degrades severely at scale.

After identification, directly updates `actors.definition_id` in SQLite.

Requires `STATEKEEP_DB_PATH`.

### Approach 5 — XState `resolveState`

Fetches all actor states via the API, calls XState's `resolveState()` on the v2 machine
for each one. Because `awaiting_docs` exists in both v1 and v2, *every* actor resolves
successfully — `resolveState` provides no eligibility signal.

Falls back to a full-table SQL UPDATE. Same 50% result as approach 2, but with extra
API calls and an XState dependency in the migration script.

Requires `STATEKEEP_DB_PATH`.

---

## Interpreting Results

```
╔══════════════════════════════════════════════════════════════════════╗
║  StateKeep Migration Benchmark — 20 actors, 2 groups                ║
╠══════════════════╦════════╦══════════╦════════════╦════════════╣
║ Approach         ║ Time   ║ Accuracy ║ Wrong      ║ Dev Lines  ║
╠══════════════════╬════════╬══════════╬════════════╬════════════╣
║ 1. APV Engine    ║  ~80ms ║   100%   ║ 0 ✓        ║ 0          ║
║ 2. Full-table SQL║   ~2ms ║    50%   ║ 10 ❌      ║ 5          ║
║ 3. Context field ║ ~140ms ║   100%*  ║ 0 ✓        ║ 25         ║
║ 4. Event history ║ ~600ms ║   100%   ║ 0 ✓        ║ 30         ║
║ 5. XState resolve║ ~200ms ║    50%   ║ 10 ❌      ║ 15         ║
╚══════════════════╩════════╩══════════╩════════════╩════════════╝
* Context field accuracy degrades silently if flags were ever missed.
```

- **Time** measures the identification + deployment phase (approach 1 includes migration wait).
- **Accuracy** is the percentage of actors routed to the correct definition.
- **Wrong** is the count of actors on the wrong definition after migration.
- **Dev Lines** is the estimated migration logic the developer must write and maintain.

**Approach 2 is fastest** but routes half the actors incorrectly.
**Approach 4 is accurate** but slow and requires dangerous direct DB access.
**Approach 1** matches approach 4's accuracy with zero developer overhead and no DB access.

---

## Environment Variables

| Variable                   | Required for      | Description                                       |
|----------------------------|-------------------|---------------------------------------------------|
| `STATEKEEP_URL`            | All               | Running server URL (default: http://localhost:3001) |
| `STATEKEEP_ADMIN_KEY`      | All               | Server admin key for creating benchmark orgs      |
| `STATEKEEP_API_KEY`        | All               | Existing API key for authenticating admin calls   |
| `STATEKEEP_DB_PATH`        | Approaches 2–5    | SQLite DB path (same as server uses)              |
| `STATEKEEP_ENCRYPTION_KEY` | Approach 3        | 64-char hex key for context decryption            |
| `ACTOR_COUNT`              | All               | Total actors to spawn (default: 20, must be even) |
| `MIGRATION_TIMEOUT_MS`     | Approach 1        | How long to wait for migrate-worker (default: 120000) |

---

## Running at Different Scales

```bash
# Quick smoke test (20 actors default)
npm run benchmark

# Larger run — good for timing comparisons
ACTOR_COUNT=200 npm run benchmark

# Stress test — observe approach 4's SQL degradation
ACTOR_COUNT=2000 npm run benchmark

# Single approach
node run-all.js --only 1      # APV engine only
node run-all.js --only 4      # Event history SQL only
node run-all.js --only 1,3,4  # Approaches 1, 3, and 4
```

## Notes

- **Each approach runs against an isolated org** — results do not interfere.
- **Only approach 1 requires `migrate-worker`** to be running. If no jobs are processed
  within `MIGRATION_TIMEOUT_MS`, the benchmark will time out with an error.
- **Approaches 2–5** bypass the migration system and write directly to SQLite. They
  require `STATEKEEP_DB_PATH`.
- **Reports** are written to `reports/benchmark-YYYY-MM-DD-HH-MM.json` after each run.
- **`npm run demo`** runs approach 1 (APV) and approach 2 (full-table) interactively with
  a side-by-side comparison.
