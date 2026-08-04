# Contributing to StateKeep

## Prerequisites

- Node.js 22 or later
- npm 10 or later
- WSL2 (Windows only) — `better-sqlite3` requires a Linux binary for the test suite

## Getting started

```bash
git clone https://github.com/mmujtaba0085/StateKeep
cd StateKeep
npm install
cp .env.example .env
# Edit .env: set STATEKEEP_ENCRYPTION_KEY and STATEKEEP_ADMIN_KEY
# Generate keys: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
node --env-file=.env src/api/server.js
```

Health check: `curl http://localhost:3001/v1/health` → `{"status":"ok","engine":"wasm",...}`

## Running tests

**Unit and integration tests** (requires WSL on Windows):
```bash
node --test test/statechart/sc*.js test/crypto.spec.js
```

**E2E tests** (Playwright — only needed if you're working on the API or dashboard; manages its own server on port 3001):
```bash
npx playwright test
```

**All tests** (WSL only):
```bash
bash scripts/run-tests.sh
```

Expected: ~444 tests, 2 skips, 0 failures.

## Architecture overview

StateKeep runs actors (live state machine instances) via:

1. **Fastify API server** (`src/api/`) — receives HTTP events, delegates to actorManager
2. **actorManager** (`src/runtime/actorManager.js`) — LRU hot registry; processes events synchronously on the main thread via the custom interpreter
3. **Custom interpreter** (`src/runtime/interpreter.js`) — processes events synchronously, returns state diff + side-effect list; zero async I/O
4. **Worker pool** (`src/runtime/workerPool.js`) — worker threads handle SPAWN, HYDRATE, TERMINATE; four-tier priority queue (urgent/high/normal/low)
5. **Write buffer** (`src/runtime/writeBuffer.js`) — deferred SQLite writes, flushed every 50 ms or at 200-item high-water mark
6. **APV engine** (`src/ffi/engine.js`) — loads the pre-built WASM module (`src/ffi/apv-engine.mjs`) that computes migration routing decisions; `apv-engine.mjs` is required — the server fails to start if it is missing

Key invariant: **EVENT processing is synchronous and on the main thread**. Workers handle lifecycle operations (SPAWN, HYDRATE, TERMINATE) only. This is the performance-critical design that keeps the event path fast.

## Definition format

StateKeep uses an XState v5-compatible JSON format for machine definitions. Supported features include flat states, hierarchical (compound) states, parallel regions, guards, actions, `after:` timed transitions, and `invoke:` services. See `docs/xstate-compatibility.md` for the full feature matrix.

You can validate a definition without deploying it:

```bash
curl -X POST http://localhost:3001/v1/definitions/validate \
  -H "x-api-key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"id":"test","definition":{...}}'
```

## Key directories

| Path | What it is |
|------|------------|
| `src/api/` | Fastify server + route handlers |
| `src/runtime/` | Actor execution: actorManager, interpreter, workerPool, writeBuffer |
| `src/registry/` | SQLite repos (actorRepo, definitionRepo, etc.) |
| `src/ffi/` | APV engine WASM bridge (`apv-engine.mjs`, `engine.js`) + fingerprint utilities |
| `src/workers/` | Background processes: migrate-worker, gc-worker, scheduler-worker, webhook-worker, and others |
| `sdk/` | TypeScript client SDK |
| `test/statechart/` | Unit + integration tests (Node built-in test runner) |
| `test/e2e/` | Playwright end-to-end tests |
| `docs/` | All documentation |
| `benchmarks/` | Performance benchmarks |

## Submitting changes

1. Fork the repo and create a branch: `git checkout -b feat/my-feature`
2. Make your changes. Run tests: `node --test test/statechart/sc*.js`
3. Commit with a conventional commit message prefix: `feat:`, `fix:`, `docs:`, `refactor:`
4. Open a pull request against `main`

For significant features or changes, open an issue first to discuss the design.

## Questions

Open an issue or email statekeep.support@gmail.com.
