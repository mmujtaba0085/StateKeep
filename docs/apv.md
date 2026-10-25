# Anchor-Point Versioning (APV)

A complete technical reference covering the formal model, implementation details, and how StateKeep handles flat, hierarchical, and parallel state machines.

> **Formal basis:** *Anchor-Point Versioning: A Formal Model for Deterministic Migration in Distributed Actor Systems* (Muhammad Mujtaba Amjad, 2026). The current, machine-checked statements are in [`formal/`](../formal/) (Lean 4; [`formal/README.md`](../formal/README.md) maps each theorem to its Lean name), and the routing code is tested against them (`test/test_model_oracle.js`).
>
> Sections 3–6 below are an informal overview in the notation of the original formulation, and their theorem numbers are those of that draft. Where they differ from `formal/` (for example, wildcard patterns, per-family registries, combined scalar/parallel routing and the collection frontier), `formal/` and the code are authoritative.

---

## Table of Contents

1. [The Problem APV Solves](#1-the-problem-apv-solves)
2. [Core Concepts](#2-core-concepts)
3. [The Four Axioms](#3-the-four-axioms)
4. [The Routing Law](#4-the-routing-law)
5. [Determinism, Irreversibility, and GC Safety](#5-determinism-irreversibility-and-gc-safety)
6. [Rescue Change-Points](#6-rescue-change-points)
7. [The History Fingerprint](#7-the-history-fingerprint)
8. [The APV Engine (APV Registry)](#8-the-apv-engine-apv-registry)
9. [Scalar (Flat) Routing — End to End](#9-scalar-flat-routing--end-to-end)
10. [Hierarchical (Compound) State Machine Routing](#10-hierarchical-compound-state-machine-routing)
11. [Parallel State Machine Routing](#11-parallel-state-machine-routing)
12. [Database Persistence](#12-database-persistence)
13. [The Full Migration Lifecycle](#13-the-full-migration-lifecycle)
14. [Performance Characteristics](#14-performance-characteristics)
15. [Known Limitations and Open Questions](#15-known-limitations-and-open-questions)
16. [Notation Reference](#16-notation-reference)

---

## 1. The Problem APV Solves

Modern workflow engines keep actors (running instances of state machine definitions) alive for days or weeks. When a machine definition changes — to fix a bug, add a state, or change transition logic — three problems arise that no prior formal treatment had solved:

**Routing:** Which actors should migrate and which should not? Two actors may be in the same current state but have arrived via completely different event histories, and only one history may be compatible with the new definition. A version number alone cannot distinguish them.

**Side effects:** How do you advance an actor to its new-definition state without re-executing the events that produced its current state? Event-log replay re-fires all actions and service invocations, which may be non-idempotent (charging a payment twice, sending a confirmation email again).

**Memory:** How do you bound the accumulation of stale machine definitions? Without a formal criterion for when an old version is unreachable, definitions accumulate indefinitely.

The standard workaround — event-log replay — fails on all three counts: it has no formal routing rule, it re-fires side effects, and it provides no GC argument. APV provides all three.

### What APV Does Instead

APV records a fixed-size fingerprint of each actor's transition history (a 32-byte SHA-256 digest per actor, plus one per parallel region; it never grows with the history) and uses that hash to determine, at migration time, which new definition version the actor should land on. No events are replayed. No side effects re-fire. The decision is deterministic: given the same hash and the same change-point registry, the answer is always the same.

---

## 2. Core Concepts

### Version

A version `v` is a deployed machine definition together with the actor execution trace it produces. Each version corresponds to a row in the `definitions` table. Formally, `v : T → S` maps logical time to machine states.

### History-Prefix Class

Two actors share a **prefix class** at logical time `t` if and only if they have processed exactly the same sequence of events before `t`. The prefix class `[v]_t` is represented by the actor's **history fingerprint**, a length-prefixed SHA-256 chain over that sequence of event types (§7). Two actors with the same fingerprint have the same history (barring a SHA-256 collision) and receive identical routing decisions.

Only events that **caused a transition** count. An event the current state ignores, or whose guard fails, doesn't change the history. System events (`SPAWN`, `MIGRATED`, …) never count.

### Change-Point

A **localized change-point** is a triple `(t*, P, r)` where:
- `t*` is the deployment tick (a monotonic integer from the APV clock, not wall time)
- `P = [v]_{t*}` is the history-prefix class that identifies which actors are targeted
- `r` is the refinement index (incremented for hotfixes to the same `(t*, P)` location)

Each change-point has an associated child version: `Child(t*, P, r)` — the definition version that eligible actors should migrate to.

`P = 0` is the wildcard: all actors on the parent definition are eligible regardless of history.

### Accessibility Function

`Acc(v, T)` selects the **unique migration target** for an actor currently on version `v`, evaluated at logical time `T`. It finds the earliest applicable change-point at or after `T` on `v`'s prefix continuation, selecting the latest refinement at that location.

If no applicable change-point exists, `Acc(v, T) = v` — the actor stays on its current version unchanged.

### Logical Time

The APV clock is a global monotonic counter. Deployment registration calls `tick()` once and stores the result as `t*`. Each actor stores `logicalStartTick` — the tick at the moment it first spawned. `Acc(v, T)` uses `T = logicalStartTick` so that an actor only becomes eligible for change-points registered *after* it was created.

Wall-clock timestamps are never used for routing. Two actors with identical event histories starting at wall-clock times τ and τ+1ms must resolve to the same version. A monotonic logical clock guarantees this; wall-clock comparison cannot.

---

## 3. The Four Axioms

The APV model is grounded in four structural axioms:

**Axiom 1 — Version Persistence.** Every registered version persists for the lifetime of the registry. No deployment can forcibly terminate or modify a running actor that is already past the change-point boundary. Actors currently holding a prefix class continue on their current version until they cross a change-point.

**Axiom 2 — Deployment Monotonicity.** Registering a change-point at `(t2, P2, r2)` does not invalidate, overwrite, or erase any change-point registered at `t1 < t2`. The registry is append-only with respect to distinct `(t, P)` locations. Only the refinement index `r` at a fixed location may be superseded. A hotfix (higher `r`) replaces the child at its own location but does not retroactively alter the routing of actors that already migrated under an earlier change-point.

**Axiom 3 — Prefix-Anchored Branching.** A new version branch is created if and only if a change-point is explicitly registered via the registry. Actors that advance forward in time without crossing a registered change-point do not create branches; they continue on their current version. Pausing an actor (gap in processing) and resuming it does not trigger migration. Only an explicit deployment that targets the actor's prefix class can cause a logic swap.

**Axiom 4 — Prefix-Anchored Earliest-Applicable Routing.** Let an actor currently in version `v` be evaluated at logical time `T`. Define the applicable change-point set:

```
C+(T; v) := { (t, [v]_t, r) ∈ C | t ≥ T }
```

If `C+(T; v)` is non-empty, find `t* = min{ t | ∃r, (t, [v]_t, r) ∈ C+(T; v) }` and `r* = max{ r | (t*, [v]_{t*}, r) ∈ C }`. Then:

```
Acc(v, T) := Child(t*, [v]_{t*; v}, r*)
```

If `C+(T; v) = ∅`, then `Acc(v, T) = v`.

The operational meaning: routing finds the earliest deployment the actor is eligible for, considering both time and prefix-class match, and selects the latest hotfix at that location. This is evaluated once per event, not once per deployment.

---

## 4. The Routing Law

> *The accessible version for an actor in version `v` evaluated at logical time `T` is the child of the earliest applicable change-point at or after `T` along `v`'s prefix continuation, selecting the latest refinement at that location; if no such change-point exists, the actor continues on `v` unchanged.*

This is the operational statement of Axiom 4. All theorems in the APV paper are consequences of this law applied under the four axioms.

---

## 5. Determinism, Irreversibility, and GC Safety

### Theorem 4.1 — Determinism

`Acc(v, T)` is uniquely defined for every actor state. No developer judgment is needed. Proof: `t*(T; v)` is the unique minimum of a non-empty set with a well-defined minimum; `r*(T; v)` is the unique maximum at the selected location; `Child` is a function (each triple maps to exactly one version).

**Computational complexity:** O(log n) where n is the number of deployments targeting prefix P. The registry stores, for each prefix class P, deployment times sorted in ascending order. `Acc(v, T)` is: (1) hash lookup for P in O(1); (2) binary search for `t*` in O(log |C_P|); (3) map lookup for `r_max` in O(1).

### Theorem 5.2 — Irreversibility of Inaccessibility

Once an actor's prefix class diverges from a branch anchor, no future deployment can create a path back to that branch. Formally: if `w = Acc(v, T)` via change-point `(t*, P, r*)` and `F ∈ V` with `[F]_{t*} ≠ P`, then there is no `T' ∈ T` such that `Acc(w, T') = F`.

This is structural, not a postulate. It follows entirely from prefix inheritance: the child `w` agrees with prefix class `P` at all times before `t*`, and every subsequent applicable change-point also inherits `P`. No deployment at a different prefix can reach `w`.

### Corollary 5.5 — GC Safety

If a prefix class `P` is vacated (no active actors carry it and no pending spawn can produce an actor with prefix `P` at `t*`), then for every active actor and every `w ∈ Child(t*, P, r)` for any `r ≥ 1`, `Acc(v, T) ≠ w` for all `T`. The entire child set may be safely garbage-collected.

### Corollary 5.7 — Refinement Pruning

For a fixed location `(t*, P)`, every child `Child(t*, P, r)` with `r < r_max` is immediately GC-eligible upon registration of `Child(t*, P, r_max)`, regardless of whether `P` is vacated.

**Memory bounds:**
- Per-location: O(1) child version in memory after any refinement
- Total registry: O(A × D) where A = active actor count and D = maximum change-point depth per actor history

---

## 6. Rescue Change-Points

An actor that migrated to a buggy deployment `Child(t*, P_orig, r_bug)` is **marooned**: by Theorem 5.2, it cannot reach versions anchored to `P_orig` (including any fix deployed there), because its prefix class has diverged.

A **rescue change-point** is a new change-point `(t', [v_bug]_{t'}, 1)` with `t' > t*` and child `v_fixed`, where `v_fixed` embodies the corrected logic. This anchors to the marooned actor's *current* prefix class, not the original one. The rescue change-point satisfies all four axioms:
- Axiom 1: `v_bug` persists
- Axiom 2: `t' > t*`, so no earlier change-point is invalidated
- Axiom 3: the rescue is explicitly registered
- Axiom 4: `v_bug` carries prefix `[v_bug]_{t'}` at `t'`, which is exactly the rescue anchor

No branch is reversed or erased. `P_orig` remains inaccessible from `v_bug`.

In StateKeep terms: when actors have `needs_rescue` status, a subsequent deployment targeting their current prefix gives them a forward path via this mechanism.

---

## 7. The History Fingerprint

The prefix class `[v]_t` is represented by a fixed-size fingerprint. Processing an event is one hash step, and routing is one lookup. This is APV's O(1)-per-event memory guarantee: one fingerprint per actor, plus one per parallel region, never growing with the history.

### Current encoding (v2): length-prefixed SHA-256 chain

```
h₀      = SHA-256("statekeep.fp.v2|empty")
hₙ₊₁    = SHA-256(hₙ ‖ u32be(len(eₙ)) ‖ utf8(eₙ))       eₙ = event type of the n-th transition
stored  = "2:" + hex(hₙ)                                 (66 characters; "0" = empty history)
```

* **Injective.** The length prefix separates events, so `[PAY, MENT_OK]` and `[PAYMENT_OK]` have different fingerprints. Two different histories can only collide if SHA-256 collides.
* **Order-sensitive.** `[START, SUBMIT]` ≠ `[SUBMIT, START]`.
* **Event types only, never payloads.** Including payloads would make `historyPath` impossible to write, because you would need every past payload.
* **Engine key.** The APV engine indexes change-points by the first 64 bits of the digest. Every hit is then **confirmed against the full 256-bit fingerprint**. A 64-bit key collision is detected and resolved by an exact scan, so it can't misroute an actor (§15).

```javascript
// src/ffi/fingerprintChain.js
export function updateFingerprint(current, eventType, hint = 2) {
  return schemeOf(current, hint) === 1
    ? updateV1(current, eventType)                                    // legacy actors only
    : V2 + stepV2(digestOf(current), eventType).toString('hex');      // "2:<64 hex>"
}
```

### Legacy encoding (v1): FNV-1a, kept only for old actors

Before v2, fingerprints were a 64-bit FNV-1a hash (16 hex characters) over the **plain concatenation** of event types (basis `0xcbf29ce484222325`, prime `0x100000001b3`). That encoding is not injective: `[PAY, MENT_OK]` and `[PAYMENT_OK]` collide by construction.

It survives only for actors that took transitions before the upgrade:
* They are upgraded to v2 from their event log when the replay provably determines their history. This happens at start-up, on `POST /v1/admin/fingerprints/upgrade`, or before an ambiguous history-targeted deployment (`src/runtime/legacyFingerprints.js`).
* An actor that can't be upgraded keeps extending its v1 fingerprint. It's matched by a history pattern only when the pattern splits into the family's event types in exactly one way; otherwise the match is refused with `LEGACY_HISTORY_AMBIGUOUS`.
* Every history-targeted change-point is registered under both encodings.

New actors never get a v1 fingerprint.

### Where this happens in code

The chain runs where the event is processed (`src/runtime/interpreter.js`, via `updateFingerprint`), and only when the event causes a transition. The result is persisted to `actors.history_fingerprint` by the write buffer, and every routing decision reads that stored value.

### Computing a deployment's pattern fingerprint

`historyPath: ['START', 'SUBMIT_INFO', 'PAY_FEE']` is hashed with the same function (`computeHistoryFingerprint` in `src/ffi/fingerprintChain.js`, re-exported as `computeHistoryHash` from `src/ffi/hashUtils.js`). The result equals the fingerprint of an actor whose transition history is exactly that sequence. The change-point is registered under the v2 engine key and the legacy v1 key, and the path itself is stored with the definition, so the full v2 fingerprint can be rebuilt after a restart.

**What matches.** A change-point with `historyPath` π applies to an actor when the actor's whole transition history so far, counted from its first event, is exactly π. That holds at deploy time, or at any later event if the actor reaches that point afterwards. It is not a substring or subsequence match. An actor already past π (its history is longer) is not moved retroactively.

---

## 8. The APV Engine (APV Registry)

The core routing logic runs in a WebAssembly module compiled from C. At startup, `src/ffi/engine.js` imports `src/ffi/apv-engine.mjs` (a small loader with the WASM binary inlined), which initialises the WebAssembly instance and exposes the APV C functions as JavaScript-callable methods. The JavaScript layer wraps these into a unified object.

The pre-built engine (`src/ffi/apv-engine.mjs`) is included in the repository, and no build step is required. If it's missing, restore it with `git checkout -- src/ffi/apv-engine.mjs` or re-clone.

The engine's C source is closed and not part of this repository. The module is still traceable:
- its header records the compiler (zig 0.13.0, pinned), the flags, and the SHA-256 of the embedded WebAssembly;
- the build is reproducible byte for byte from the engine source (`make verify` in the engine package);
- `make -C src/ffi check` confirms the module loads and has every export StateKeep uses.

The routing rule it implements is published and proved in [`formal/`](../formal/), and the engine is tested against it (`test/test_model_oracle.js`, `test/test_engine_ex.js`).

**Keys.** The engine works on opaque 64-bit keys, and StateKeep bridges them to its 256-bit fingerprints:
- The scalar key of a v2 fingerprint is the **first 64 bits of its SHA-256 digest**. For a legacy v1 actor, it's the 64-bit FNV-1a fingerprint itself.
- Different histories can share a key. Every engine hit is therefore **confirmed against the full fingerprint**, and a mismatch falls back to an exact scan (`src/runtime/routingRegistry.js`), so a shared key costs a scan and never misroutes.
- **Scalar key 0 is reserved for the wildcard:** a change-point with key 0 applies to every actor. StateKeep never produces 0 as the key of a real history (`engineKey` maps 0 to 1).
- Parallel region keys hash the region path together with the regional fingerprint. They have no reserved value.
- Inside the engine, FNV-1a is used only to combine a parallel selector's keys into one composite key, which picks a hash bucket; the full selector set is still compared. The `apv_fnv1a_*` helpers serve legacy keys and family scope ids.

### Exported Functions

| C Function | Purpose |
|---|---|
| `apv_registry_create` | Allocate the in-memory registry |
| `apv_registry_destroy` | Free the registry |
| `apv_clock_tick` | Advance and return the monotonic APV clock |
| `apv_register_changepoint` | Register a scalar (single-fingerprint) change-point |
| `apv_compute_accessible` | Route an actor by its scalar fingerprint |
| `apv_fnv1a_init` | Initialize an FNV hash accumulator (legacy v1 fingerprints) |
| `apv_fnv1a_update` | Update the hash with new bytes |
| `apv_fnv1a_final` | Finalize the hash |
| `apv_register_changepoint_parallel` | Register a parallel (multi-region) change-point |
| `apv_compute_accessible_parallel` | Route an actor by its per-region fingerprint array |

### Added in the current engine build

| C Function | Purpose |
|---|---|
| `apv_clock_now` | Read the clock without advancing it |
| `apv_clock_advance_to` | `clock = max(clock, t)` in O(1) — restores the clock after a restart (before, the server called `apv_clock_tick` once per past tick) |
| `apv_register_changepoint_scoped` / `apv_compute_accessible_scoped` | Scalar change-points in a **scope** |
| `apv_register_changepoint_parallel_scoped` / `apv_compute_accessible_parallel_scoped` | Parallel change-points in a scope |
| `apv_compute_accessible_scoped_ex` / `apv_compute_accessible_parallel_scoped_ex` | Lookups that also return the hit's t\* (and, for scalar lookups, the matched key: the actor's own or 0 for the wildcard) |
| `apv_collect_before_scoped` | Remove every change-point of a scope below the collection frontier: this is the registry's garbage collection |

**Removed:** `apv_actor_started`, `apv_actor_stopped` and `apv_vacate_prefix` (per-actor live counting). They only searched scope 0, while every change-point is registered in a family scope, so they never had any effect. Garbage collection is `apv_collect_before_scoped`, driven by the collection frontier.

**Scopes.** The registry is shared by every workflow on a server. Unscoped, the first
change-point a lookup found could belong to *another* workflow; StateKeep discarded that
answer, and the actor silently stayed on its old version (found by the workflow chaos
simulation). StateKeep now registers each change-point in its workflow family's scope
(`scopeOf(machineId)`, a 64-bit FNV-1a of the family id) and looks up in the actor's
family scope, so workflows can no longer hide each other's deployments. The unscoped
functions are scope 0 and behave exactly as before.

**Other engine changes in this build:** parallel registration refuses ambiguous selectors
(`-2`, as the previous shipped build did); parallel lookups use a per-t\* index (a lookup
across 2,000 parallel change-points went from ~13 s to ~10 ms in a native benchmark);
registration is all-or-nothing under out-of-memory; duplicate region hashes in a selector
are ignored (selectors are sets). `test/test_apv_conformance.js` checks the engine against
a reference model of all of these rules.

### Engine Requirement

`apv-engine.mjs` is required — if it is missing, the server fails to start. There is no fallback mode. The health endpoint reports `"engine": "wasm"` when the WASM engine is loaded successfully.

### Registering a Change-Point

```javascript
// src/ffi/engine.js
registerChangepoint(tStar, prefixHash, refinement, childDefId) {
  return _register(reg, BigInt(tStar), BigInt(prefixHash), BigInt(refinement), childDefId);
}
```

- `tStar`: the APV clock tick at deployment time
- `prefixHash`: the target fingerprint (0n = wildcard)
- `refinement`: hotfix counter at this `(tStar, prefixHash)` location
- `childDefId`: the definition ID string actors should migrate to

### Computing Accessibility

```javascript
computeAccessible(currentPrefixHash, actorLogicalTime, currentTime) {
  const outBuf = Buffer.alloc(OUTPUT_BUFFER_SIZE, 0);
  const rc = _compute(reg, BigInt(currentPrefixHash), BigInt(actorLogicalTime), BigInt(currentTime), outBuf, OUTPUT_BUFFER_SIZE);
  if (rc === 0) return null;
  return outBuf.toString('utf8').replace(/\0/g, '').trim();
}
```

Returns the target `childDefId` string, or `null` if no applicable change-point exists.

---

## 9. Scalar (Flat) Routing — End to End

This is the simplest case: a state machine with no parallel regions and no deeply nested sub-states. Every actor has a single `historyFingerprint`.

### Step 1: Deploy New Version

```http
PUT /v1/definitions
{
  "id": "loan-v2",
  "parentId": "loan-v1",
  "definition": { ... },
  "historyPath": ["SUBMIT", "VERIFY_DOCS", "APPROVE"]
}
```

In `src/api/routes/definitions.js`:

1. `computeHistoryFingerprint(['SUBMIT', 'VERIFY_DOCS', 'APPROVE'])` → `"2:79cff0d92c527c44…22539c"` (full SHA-256 chain, 64 hex digits)
2. `registerScalar(...)` (`src/runtime/routingRegistry.js`) registers the change-point in the engine under the fingerprint's 64-bit key `0x79cff0d92c527c44` (and under the legacy v1 key), in the family's scope, and keeps the full fingerprint to confirm hits
3. `insertChangepoint({ tStar, prefixHash, refinement: 1, childDefId: "loan-v2" })` → persisted to the `changepoints` table

The `_historyPath: ["SUBMIT", "VERIFY_DOCS", "APPROVE"]` is embedded in the stored definition JSON so it survives restarts.

### Step 2: Actor Events Accumulate the Fingerprint

An actor spawned on `loan-v1` processes events through the worker:

```
SPAWN        → historyFingerprint = "0"                     (empty history; SPAWN is not a transition)
SUBMIT       → historyFingerprint = "2:0469950248f1874c…"   = step(h₀, "SUBMIT")
VERIFY_DOCS  → historyFingerprint = "2:a47acd00ca67691b…"   = step(…, "VERIFY_DOCS")
APPROVE      → historyFingerprint = "2:79cff0d92c527c44…"   = step(…, "APPROVE")
```

After the third event the actor's fingerprint equals the pattern's fingerprint: its whole history so far is exactly `[SUBMIT, VERIFY_DOCS, APPROVE]`. The worker returns the new fingerprint; the write buffer flushes it to `actors.history_fingerprint` within 50ms.

### Step 3: Migration Job Enqueued

When `loan-v2` is deployed, `definitions.js` calls the engine to identify matching actors:

```javascript
const actorPrefixHash = fingerprintToBigInt(actor.historyFingerprint);
const logicalTime = currentDeployedAt > logicalStartTick
  ? BigInt(currentDeployedAt) + 1n
  : BigInt(logicalStartTick);

targetDefId = eng.computeAccessible(actorPrefixHash, logicalTime, currentTick);
```

For the actor with fingerprint `"a3f2c9018bd4e701"`, this returns `"loan-v2"`. A migration job is enqueued in `migration_jobs`.

Actors whose fingerprint does not match `"a3f2c9018bd4e701"` get `null` from `computeAccessible`. They stay on `loan-v1`.

### Step 4: Background Migration Worker

`src/workers/migrate-worker.js` picks up the job:

1. **Re-check eligibility** — the actor's fingerprint may have changed since the job was enqueued (actor processed more events). It calls `eng.computeAccessible` again with current data. If the fingerprint no longer matches the target, the job is cancelled and logged as `fingerprint_changed`.

2. **HYDRATE** — sends a `HYDRATE` message to the worker pool with the target definition JSON, the actor's current context, and the state mapping. The worker thread compiles the new definition and uses `restoreSnapshot()` to place the actor at the appropriate landing state in the new definition, without replaying any events.

3. **Persist** — the actor row is updated: `definition_id → loan-v2`, `history_fingerprint` unchanged (the fingerprint is never recomputed from context — it represents the event chain, not the current state).

4. **MIGRATED event**: inserted into the events log, in the same transaction as the move.

### Step 5: No Change-Point → No Migration

Actors that never processed `APPROVE` — or processed it in a different order — have a different fingerprint. The engine returns `null` for them. They keep running on `loan-v1` indefinitely (or until a wildcard deploy targets them).

---

### What a migration does and does not do

| A migration… | |
|---|---|
| keeps the actor's context (after `contextTransform`) and its history fingerprint | ✅ |
| places the actor in its landing state (`stateMapping`, per leaf for nested and parallel states) | ✅ |
| writes a `MIGRATED` event in the same transaction as the move | ✅ |
| cancels the old state's `after:` timers and schedules the landing state's timers | ✅ (timers are not side effects) |
| runs the landing state's **entry actions** | ❌ never |
| replays any events | ❌ never |

Not running entry actions is what guarantees that a migration never fires side effects:
an actor already in `shipped` has already had `shipped`'s entry actions run on the version
it entered. The flip side is that if v2 **adds** an entry action to a state, actors that
migrate *into* that state do not run it; only actors that enter the state by a transition
afterwards do. If the new action must reach migrated actors, send them an event that runs it,
or deploy a step that does. (An opt-in to run selected entry actions on migration is being
considered; actions have delivery modes, so it can be made safe.)

**Event-history pruning.** With `STATEKEEP_MAX_EVENT_HISTORY_DAYS` set (off by default), old
user events are deleted, so the history is no longer a complete audit log and no longer
replays to the current state. Routing is unaffected because it uses the stored fingerprints.

---

## 10. Hierarchical (Compound) State Machine Routing

A compound state machine has nested states — e.g. `processing.waiting_for_docs` or `review.manager_review`. From APV's perspective, the scalar fingerprint works exactly the same way regardless of nesting depth.

### Fingerprint is State-Structure Agnostic

The fingerprint chain accumulates event types in order. Whether the machine transitions between top-level states or sub-states, the fingerprint chain is identical. `historyPath: ['START', 'DOCS_UPLOADED']` is computed the same way whether `DOCS_UPLOADED` transitions to `processing.waiting_for_approval` or `approved` at the top level.

### Landing State Resolution

When a migrating actor has a compound state value like `{ processing: "waiting_for_docs" }`, the worker resolves where it lands in the new machine via `resolveLandingState` (`src/runtime/actorWorker.js`):

```javascript
export function resolveLandingState(currentStateValue, newMachineStates, stateMapping = {}) {
  // ...
  // Compound or parallel state value object
  if (currentStateValue && typeof currentStateValue === 'object') {
    const topLevel = Object.keys(currentStateValue)[0];
    const mappedKey = stateMapping[topLevel];
    if (mappedKey) {
      return newMachineStates[mappedKey] ? mappedKey : null;
    }
    // Top-level key exists in new machine: return the full compound value
    // so the interpreter's restoreSnapshot() can place the actor at the
    // exact nested position without replaying events.
    if (newMachineStates[topLevel]) return currentStateValue;
    return null;
  }
}
```

If the top-level state name still exists in the new machine (e.g. `processing` is still a state in `loan-v2`), the full compound value `{ processing: "waiting_for_docs" }` is returned as the landing state and passed to the interpreter's `restoreSnapshot()`, which places the actor at that exact nested position without replaying any events.

If the old top-level state was renamed (e.g. `processing → under_review`), the `stateMapping` field handles the redirect:

```json
{
  "stateMapping": { "processing": "under_review" }
}
```

If no mapping exists and the state doesn't exist in the new machine, `resolveLandingState` returns `null` and the actor is tagged `needs_rescue`.

### Deep Nesting

The fingerprint doesn't need to know about nesting depth. An actor in `{ processing: { review: "manager_review" } }` has the same fingerprint as it would if the machine were flat — the events that got it there are what matter, not the current nested structure.

---

## 11. Parallel State Machine Routing

Parallel state machines (XState `type: "parallel"`) run multiple regions simultaneously. An actor in a parallel machine may be in `{ regionA: "stateX", regionB: "stateY" }` at the same time.

The scalar fingerprint is insufficient for parallel machines because a single event may cause transitions in one region but not another. Two actors in the same overall parallel state may have arrived via completely different regional histories.

### Region Paths at Any Nesting Depth

**Parallel regions are tracked at any depth in the state tree — not just at the top level.** The region path is a full dot-separated path from the root to the region. For example:

```json
{
  "states": {
    "active": {
      "states": {
        "setup": {
          "type": "parallel",
          "states": {
            "payment": {},
            "shipping": {}
          }
        }
      }
    }
  }
}
```

This yields region paths `["active.setup.payment", "active.setup.shipping"]`. `extractParallelRegionPaths` recurses into every node in the state tree and collects a parallel node's children at whatever depth it encounters them. Multiple nested parallel nodes in the same machine each contribute their own set of region paths.

### The Solution: Per-Region Fingerprints

Each parallel region accumulates its own independent fingerprint chain (same encoding as the main fingerprint). A region's fingerprint only advances when an event causes a transition *in that region*.

#### Detecting Region Transitions

In `src/runtime/statePaths.js`, `updateRegionFingerprintsForTransition` compares the pre-event and post-event state values for each region:

```javascript
export function updateRegionFingerprintsForTransition(
  definition, preStateValue, postStateValue, eventType, current = null
) {
  const regionPaths = extractParallelRegionPaths(definition);
  const result = {};
  for (const regionPath of regionPaths) {
    const postRegion = getStateValueAtPath(postStateValue, regionPath);
    if (postRegion === undefined) continue;
    const preRegion = getStateValueAtPath(preStateValue, regionPath);
    let fp = current?.[regionPath] ?? '0';
    if (preRegion !== undefined && !stateValuesEqual(preRegion, postRegion)) {
      fp = updateFingerprint(fp, eventType);   // region changed — advance its chain
    }
    result[regionPath] = fp;
  }
  return Object.keys(result).length > 0 ? result : null;
}
```

If `SUBMIT_PAYMENT` causes `{ payment: "processing" → "verified", shipping: "pending" → "pending" }`, only the `payment` region's fingerprint advances. The `shipping` region's fingerprint stays at its previous value.

#### Region Path Extraction

`extractParallelRegionPaths` walks the machine definition JSON to find all parallel region paths:

```javascript
export function extractParallelRegionPaths(definition) {
  const paths = new Set();
  function visit(node, path) {
    if (node.type === 'parallel') {
      for (const regionName of Object.keys(states)) {
        paths.add(dotPath([...path, regionName]));
      }
    }
    for (const [stateName, child] of Object.entries(states)) {
      visit(child, [...path, stateName]);
    }
  }
  visit(definition, []);
  return [...paths].sort();
}
```

For a machine with a top-level parallel state, this returns paths like `["payment", "shipping"]`. For a nested parallel state inside `processing`, paths might be `["processing.payment", "processing.shipping"]`.

### Path-Keyed Encoding

A critical insight: if two regions happen to have identical event histories, they would produce identical fingerprints. Passing two identical uint64 values to the APV engine would look like one region to the registry. To prevent false-positive cross-region matches, each region's fingerprint is **path-keyed** — the region's full dot-path is baked into the value before it's passed to the engine.

```javascript
// src/ffi/hashUtils.js
export function encodeRegionFingerprint(regionPath, regionFingerprintHex) {
  return computeHash([
    'statekeep.region.v1',  // namespace sentinel
    '\0',
    regionPath,             // e.g. "processing.payment"
    '\0',
    normalizeRegionFingerprintHex(regionFingerprintHex),
  ]);
}
```

This produces a 64-bit engine key that is unique to the combination of `(regionPath, fingerprint)`. The code above is the legacy (v1) form. For v2 fingerprints the key is the first 64 bits of `SHA-256("statekeep.region.v2|" ‖ u32be(len(path)) ‖ path ‖ digest)` (`regionKeyV2` in `src/ffi/fingerprintChain.js`), and hits are confirmed against the full regional fingerprints. Two regions with the same event history but different paths produce different encoded values.

### AND Semantics

A parallel change-point requires ALL specified regions to match simultaneously. This is the AND composition: an actor is only eligible if region A's encoded fingerprint AND region B's encoded fingerprint both match the registered values.

When deploying with `historyRegions`:

```http
PUT /v1/definitions
{
  "id": "order-v2",
  "parentId": "order-v1",
  "definition": { ... },
  "historyRegions": {
    "payment": ["PAY_INITIATED", "PAY_CONFIRMED"],
    "shipping": ["ADDRESS_SET", "CARRIER_SELECTED"]
  }
}
```

In `definitions.js`:

```javascript
const regionHexMap = computeRegionHashes(normalizedHistoryRegions);
// { "payment": "abc...", "shipping": "def..." }

const regionArr = regionFingerprintsToArray(regionHexMap);
// [encodeRegionFingerprint("payment", "abc..."), encodeRegionFingerprint("shipping", "def...")]
// as BigInt array

eng.registerChangepointParallel(tStar, regionArr, 1n, "order-v2");
insertParChangepoint({ tStar, regionHashesHexMap: regionHexMap, refinement: 1, childDefId: "order-v2" });
```

At routing time, the actor's stored `regionFingerprints` (`{ payment: "abc...", shipping: "def..." }`) is encoded and passed to the engine:

```javascript
const regionArr = regionFingerprintsToArray(actor.regionFingerprints);
// encodes each (path, fp) pair before passing to the engine
targetDefId = eng.computeAccessibleParallel(regionArr, logicalTime, currentTick);
```

The APV engine checks whether *all* provided region fingerprints match the registered change-point. Only actors where the full vector matches are eligible.

### Versioned Storage Format

Region fingerprints are stored in the `actors.region_fingerprints` column as a JSON blob. The codec (`src/registry/regionFingerprintCodec.js`) enforces a versioned format:

```json
{ "_v": 2, "regions": { "payment": "abc...", "shipping": "def..." } }
```

Version 2 is the current wire format. Unversioned rows (from pre-APV code) are rejected on read (cleared by DB migration v17). This prevents old unkeyed fingerprints — which lack path encoding — from causing false-positive parallel routing decisions.

### Regional Applicability Order and Tie-Breaking

The formal routing rule for parallel change-points has three-level tie-breaking (from the APV formal model):

1. **Earliest deployment time** — among all applicable parallel change-points, select those with the minimum `t*` ≥ actor's `logicalStartTick`
2. **Most specific selector** — among those, prefer the selector with the largest number of regions (`|dom(Sel)|`). A two-region selector is preferred over a one-region selector, even if both match.
3. **Highest refinement** — among those, select the maximum refinement index `r`

This means a deployment targeting both `payment` AND `shipping` regions takes precedence over one targeting only `payment`, when an actor satisfies both.

### Selector Compatibility and Well-Formedness

Two selectors `Sel1` and `Sel2` are **compatible** if there exists an actor regional prefix set that matches both simultaneously. For selectors sharing a region path `ρ`, they are compatible only if they specify the same encoded fingerprint for `ρ`. If a shared region path requires two different regional fingerprints, the selectors are incompatible — no actor can satisfy both.

A parallel change-point registry is **well-formed** when, at any deployment time `t`, two distinct selectors of equal specificity and equal refinement either (a) are incompatible (cannot both match the same actor) or (b) are superseded by a more specific selector that matches any actor matching both. This ensures `computeAccessibleParallel` always returns a unique result.

### Partial-Region Progress and Stable Snapshots

Parallel actors do not need to progress uniformly across all regions:

- An actor may have completed `setup.payment` while `setup.shipping` is still in its initial state — or vice versa.
- A selector containing only `setup.payment` matches as soon as the payment regional fingerprint matches, regardless of shipping or other regions.
- A selector containing both `setup.payment` AND `setup.shipping` matches only when both regional fingerprints match simultaneously.

**Stable snapshot rule:** A region's fingerprint advances *only if* the region was active both before and after the transition (`preRegion !== undefined` AND state changed). Newly active regions start from the '0' sentinel (`current?.[regionPath] ?? '0'`). Inactive regions are absent from the actor's regional prefix set (`if (postRegion === undefined) continue`). A selector cannot match a region that is not currently active.

Migration is evaluated at stable logical ticks — after an event has been fully processed and a complete state snapshot exists, never in the middle of an internal interpreter transition.

### Parallel Determinism Theorem

For every well-formed parallel change-point registry and every actor state, regional accessibility is uniquely defined (mirrors Theorem 4.1 from the scalar case). The proof structure: the applicable set is finite, earliest-time uniquely determined by total order, selector specificity is an integer with a maximum, refinement index is a natural number with a maximum, and well-formedness eliminates the only remaining ambiguity case (two equally-specific selectors at the same time and refinement that are compatible).

### Mutual Exclusion with Scalar Routing

`historyPath` (scalar) and `historyRegions` (parallel) are mutually exclusive on a single deployment. A definition either targets actors by their single-chain fingerprint or by their per-region fingerprint vector. This is enforced in the API:

```javascript
if (hasHistoryPath && hasHistoryRegions) {
  return reply.code(400).send({
    error: 'historyPath and historyRegions are mutually exclusive. Use historyPath for scalar routing or historyRegions for parallel-region routing.',
  });
}
```

### Three-Tier Recheck in migrate-worker

When a migration job is processed, the worker performs a three-tier eligibility recheck:

```javascript
// Tier 1: scalar engine
recheck = eng.computeAccessible(fingerprintToBigInt(actor.historyFingerprint), recheckLogicalTime, BigInt(currentTick));

// Tier 2: DB-level wildcard (engine can't match non-zero fingerprints against prefix_hash=0)
if (!recheck) {
  recheck = getWildcardChildDef(actor.definitionId, wildcardLowerBound);
}

// Tier 3: parallel regions
if (!recheck && actor.regionFingerprints) {
  const regionArr = regionFingerprintsToArray(actor.regionFingerprints);
  if (regionArr?.length > 0) {
    recheck = eng.computeAccessibleParallel(regionArr, recheckLogicalTime, BigInt(currentTick));
  }
}
```

If none of the three tiers returns a match, the job is cancelled (`fingerprint_changed`). An actor may legitimately fail the recheck if it processed more events between job enqueueing and job processing, causing its fingerprint to advance past the registered prefix.

---

## 12. Database Persistence

APV state survives server restarts through three DB columns and two tables.

### `actors.history_fingerprint`

`"2:<64 hex>"` (v2), `"0"` for an empty history, or a 16-char hex string for a legacy v1 actor. Updated by the write buffer whenever an event causes a transition. This is the actor's current position in the fingerprint chain: `[v]_t` in formal terms.

### `actors.region_fingerprints`

A TEXT column holding the versioned codec blob: `{"_v":2,"regions":{"regionPath":"hexFp",...}}`. Only populated for actors on parallel machines. `null` for flat and compound machines.

### `changepoints` table

Scalar change-points. One row per deployment that uses `historyPath` (or no history targeting — wildcard).

| Column | Description |
|---|---|
| `t_star` | APV clock tick at deployment |
| `prefix_hash` | Target fingerprint ('0' = wildcard) |
| `refinement` | Hotfix index |
| `child_def_id` | Target definition ID |

### `par_changepoints` table

Parallel change-points. One row per deployment that uses `historyRegions`.

| Column | Description |
|---|---|
| `t_star` | APV clock tick at deployment |
| `region_hashes` | JSON: either `{ "regionPath": "hexFp", ... }` (new map format) or `["hexFp", ...]` (legacy array) |
| `refinement` | Hotfix index |
| `child_def_id` | Target definition ID |

### Registry Reconstruction on Restart

When `migrate-worker.js` starts, it calls `syncRegistry()` which loads all changepoints from both tables and re-registers them with the APV engine:

```javascript
const rows = loadChangepointsAfter(_lastChangepointId);
for (const row of rows) {
  eng.registerChangepoint(BigInt(row.t_star), BigInt(row.prefix_hash), BigInt(row.refinement), row.child_def_id);
}

const parRows = loadParChangepointsAfter(_lastParChangepointId);
for (const row of parRows) {
  const storedRegions = JSON.parse(row.region_hashes);
  const regionArr = Array.isArray(storedRegions)
    ? storedRegions.map(h => BigInt(`0x${h.padStart(16, '0')}`))  // legacy format
    : regionFingerprintsToArray(storedRegions);                   // new map format
  eng.registerChangepointParallel(BigInt(row.t_star), regionArr, BigInt(row.refinement), row.child_def_id);
}
```

Cursor variables (`_lastChangepointId`, `_lastParChangepointId`) prevent double-loading. The same `syncRegistry` runs at the top of each `processLoop` iteration to pick up any changepoints registered since the last poll.

### `actors.logical_start_tick`

Stored when the actor is first spawned. This is `T` in `Acc(v, T)`. The engine uses it to filter change-points: only change-points with `t* ≥ logicalStartTick` are applicable. An actor cannot be migrated to a definition that was deployed before it was created.

---

## 13. The Full Migration Lifecycle

Here is the complete flow from deployment to fully migrated actor.

```
Operator deploys new definition via PUT /v1/definitions
          │
          ▼
definitions.js validates the machine definition
          │
          ├─── If stranded actors exist and no confirmToken ──► return 200 requires_confirmation
          │
          ▼
eng.clockTick() → tStar
          │
          ├─── historyPath provided ──────────────────────────────────────────────────────┐
          │    computeHistoryHash(historyPath) → prefixHash                               │
          │    eng.registerChangepoint(tStar, prefixHash, refinement, id)                 │
          │    insertChangepoint(...)                                                       │
          │                                                                                │
          ├─── historyRegions provided ───────────────────────────────────────────────────┤
          │    computeRegionHashes(historyRegions) → regionHexMap                         │
          │    regionFingerprintsToArray(regionHexMap) → [encodedBigInt, ...]             │
          │    eng.registerChangepointParallel(tStar, regionArr, refinement, id)          │
          │    insertParChangepoint(...)                                                   │
          │                                                                                │
          └─── neither (wildcard) ────────────────────────────────────────────────────────┘
               prefixHash = 0n
               eng.registerChangepoint(tStar, 0n, refinement, id)
               insertChangepoint({ prefixHash: '0', ... })
          │
          ▼
For each actor on the machine family:
  eng.computeAccessible(actorFp, logicalTime, currentTick)  [scalar]
  eng.computeAccessibleParallel(regionArr, logicalTime, currentTick)  [parallel]
  → if returns this definition's ID: enqueue migration_job
          │
          ▼
migrate-worker picks up jobs every 500ms (BATCH_SIZE=500)
          │
          ▼
For each job:
  1. syncRegistry() — load any new changepoints
  2. Re-check eligibility (3-tier: scalar → wildcard DB → parallel)
     → if no match: markFailed("cancelled: fingerprint_changed")
  3. updateActorStatus(actor_id, 'migrating')
  4. migrateActor(actor_id, target_def_id, { priority: 'low' })
     → actorManager sends HYDRATE to worker pool
     → worker uses custom interpreter to restore actor at landing state
     → write buffer flushes updated actor row (new definitionId, same fingerprint)
  5. INSERT MIGRATED event into events log (same transaction as the move)
  6. markDone(job_id)
  7. evictFromApiCache(actor_id) — hot registry cache cleared
          │
          ▼
Actor is now on new definition, fingerprint unchanged, context transformed if configured
```

---

## 14. Performance Characteristics

From empirical evaluation at 10^3–10^6 actors with 10–10^4 change-points:

| Metric | APV | Event-sourcing replay |
|---|---|---|
| Memory per actor | 32 bytes (SHA-256 digest), plus 32 per parallel region | Full event log |
| Routing time | O(log n) per actor | O(N) per actor (N = event count) |
| Memory at 100k actors | 13.32 MB | 83.60 MB (−84.1%) |
| Routing time at 100k actors | 19.01 ms | 313.04 ms (−93.9%) |
| Memory at 1M actors | 119 MB | 829 MB (−85.6%) |
| Routing time at 1M actors | 447 ms | 4,318 ms (−89.7%) |
| Per-actor routing cost | ~40–80 ns | proportional to history length |

The O(log n) prediction is confirmed empirically: doubling change-points from 1k to 10k adds at most 1 ns/actor.

### Machine Cache

Each worker thread maintains a compiled definition cache (`_compiledCache`) capped at 512 entries. `compileMachine()` calls are relatively expensive; caching the compiled output yields ~55 migration jobs/second throughput. The cache uses reference-counted eviction: entries with live actors pinned by `_definitionRefCounts` are never evicted, even under memory pressure.

---

## 15. Known Limitations and Open Questions

### Fingerprint collisions

**Fingerprints (v2).** Two different histories have the same fingerprint only if SHA-256 collides, which isn't a practical concern. The length-prefixed encoding also rules out the *structural* collisions of plain concatenation (`[PAY, MENT_OK]` vs `[PAYMENT_OK]`).

**Engine keys.** The engine indexes change-points by the first 64 bits of a fingerprint, so two different fingerprints can share a key. By the birthday bound that becomes likely only around 2³² ≈ 4×10⁹ distinct histories, and it's **harmless**: every engine hit is confirmed against the full 256-bit fingerprint, and a mismatch falls back to an exact scan of the family's change-points (`verifyScalar` / `scalarByScan` in `src/runtime/routingRegistry.js`; tested by forging a key collision in `test/test_engine_ex.js`). A key collision costs a scan; it can't misroute.

**Legacy v1 fingerprints** are 64-bit FNV-1a over the plain concatenation and are not injective. See §7 for how they're upgraded, or refused when a match would be ambiguous.

**Regional fingerprints** add no extra risk: the region path is hashed into each regional key, so identical histories in two regions give different keys.

---

### GC Safety When an Actor's Own Version Is Eligible

Corollaries 5.5 and 5.7 describe GC of *child* versions at vacated prefix classes. A natural question: can an actor's *current* version `v` itself become GC-eligible while the actor is still mid-flight?

**No — and this follows directly from Axiom 1 combined with the definition of vacated.**

The `Live(t*, P)` set (Definition 5.4) includes every active actor carrying prefix class `P` at `t*`. If an actor is actively running on version `v`, it is in the `Live` set of `v`'s own prefix class. A prefix class is only vacated when `Live(t*, P) = ∅` — so as long as any actor runs on `v`, `v`'s prefix class is not vacated. GC of `v` is axiomatically impossible while any actor is on it.

In practice, the registry is collected by **frontier**. For each workflow family, StateKeep computes the earliest logical time that any routable actor (active, stranded or archived) or any future spawn can still have. That is the collection frontier, which is proved safe in `formal/APV.lean`. Every change-point below it is removed (`apv_collect_before_scoped`). A running actor's logical time is at or above the frontier by definition, so nothing it can still reach is ever removed.

An archived actor still counts toward the frontier, because it can be restored.

---

### Rescue Change-Point Cascade

If a rescue change-point itself contains a bug, requiring another rescue: the mechanism composes recursively. The second rescue is simply another instance of Definition 6.1 with `v_bug := v_rescue`:

```
v_orig → [buggy deploy at t*] → v_bug      (marooned)
v_bug  → [rescue at t']       → v_rescue   (also buggy)
v_rescue → [rescue at t'']    → v_fixed
```

At each level the axioms hold independently. The irreversibility theorem applies at each anchor — no rescue can route back to a previous buggy branch, only forward to the next. There is no depth limit and no requirement that the chain terminates at any fixed number of rescues.

In practice: each rescue creates a new `needs_rescue` state for actors that couldn't migrate, and a new deployment with those actors' current prefix class as the anchor. Operators see this as successive deployments in the Machines page.

---

### Mixed Machines: Compound State Containing Parallel Regions — Worked Example

This is the hardest correctness surface. Consider a machine with a compound top-level state that contains a nested parallel state:

```json
{
  "initial": "active",
  "states": {
    "active": {
      "initial": "setup",
      "states": {
        "setup": {
          "type": "parallel",
          "states": {
            "payment":  { "states": { "pending": {}, "verified": {} }, "initial": "pending" },
            "shipping": { "states": { "pending": {}, "confirmed": {} }, "initial": "pending" }
          }
        },
        "review": {}
      }
    },
    "done": {}
  }
}
```

An actor in `{ active: { setup: { payment: "verified", shipping: "pending" } } }` has:
- `historyFingerprint` = the global chain of ALL events processed so far (scalar)
- `regionFingerprints` = `{ "active.setup.payment": "abc...", "active.setup.shipping": "000..." }`

**On migration**, both surfaces are handled independently then combined:

**Step 1 — Landing state resolution** (`resolveLandingState`): `currentStateValue = { active: { setup: { payment: "verified", shipping: "pending" } } }`. The top-level key is `"active"`. If `"active"` exists in the new machine's states, the full compound value `{ active: { setup: ... } }` is used as the landing state and passed to `restoreSnapshot()`, which places the actor at that exact nested position in the new definition without replaying any events.

**Step 2 — Region fingerprints** pass through unchanged. `initializeRegionFingerprints` is called on the new definition + new stateValue. It calls `extractParallelRegionPaths` on the new definition — if the new machine still has `active.setup.payment` and `active.setup.shipping`, those paths are re-extracted and the existing fingerprints `{ "active.setup.payment": "abc...", "active.setup.shipping": "000..." }` are carried over directly. If the new machine renamed the parallel structure (e.g. `active.setup → active.configure`), the old region paths don't match — region fingerprints start fresh from `'0'` for the new paths.

**Step 3 — Subsequent events** in the new machine update only the regions that transition. If `PAYMENT_CONFIRMED` causes `payment: "pending" → "verified"` but leaves `shipping` unchanged, only `active.setup.payment` advances. The shipping fingerprint is untouched.

**The combination of compound + parallel deployments:** A deployment can target this actor either via `historyPath` (global scalar fingerprint) or `historyRegions` (per-region fingerprints targeting `active.setup.payment` and/or `active.setup.shipping`). The two modes are mutually exclusive per deployment — see the next section.

---

### historyPath and historyRegions Mutual Exclusivity — Known Limitation

A machine can have both flat top-level states and a parallel sub-tree. An operator might want to target actors that have *both* processed a specific global event sequence *and* have a specific regional state. Currently, a single deployment must choose one routing mode:

- `historyPath` routes by the actor's global scalar fingerprint (reflects ALL transitions, including those inside parallel regions)
- `historyRegions` routes by per-region fingerprints for specified regions only

**These cannot be combined in a single deployment** — the API enforces mutual exclusion and returns HTTP 400 if both are provided.

**Why this is a design choice, not a bug:** The APV engine's two routing surfaces (`apv_compute_accessible` and `apv_compute_accessible_parallel`) are called sequentially in a three-tier check. Combining them would require a compound AND predicate not supported by the current engine ABI: a deployment would need to match both a scalar prefix AND a regional prefix vector simultaneously. That would require a new engine function and a corresponding DB column.

**Workaround:** Use two sequential deployments. The first deployment (wildcard or `historyPath`) gets actors to an intermediate version. The second deployment uses `historyRegions` to further route. Because APV is a DAG (Theorem 5.2), the two-hop result is identical to what a single combined deployment would produce.

**This is a known gap** between the formal model (which is agnostic about how selectors are structured) and the current implementation.

---

### Selector Well-Formedness: Asserted, Not Enforced

Section 11 defines a "well-formed" parallel change-point registry as one where no two compatible selectors of equal specificity and equal refinement at the same deployment time route to different children. The determinism theorem (Theorem 5.6) assumes the registry is well-formed.

**StateKeep does not currently validate well-formedness at registration time.**

`insertParChangepoint` and `registerChangepointParallel` insert rows without checking for conflicting parallel selectors. If an operator registers two parallel change-points at the same `tStar` with compatible selectors of equal specificity and equal refinement that point to different child definitions, `computeAccessibleParallel` in the APV engine will return one of them — but which one is implementation-defined.

**In practice this is prevented by the API's `historyRegions` mutual-exclusion check** between `historyPath` and `historyRegions` on a single definition ID, and by the fact that each `PUT /v1/definitions` call produces exactly one change-point for one child definition. Two operators cannot register conflicting parallel change-points at the exact same APV clock tick unless they make simultaneous requests. The APV clock is a strict monotonic integer (`apv_clock_tick`), so simultaneous requests produce different ticks.

**The remaining risk** is: two deployments at *different* ticks, where both `t*₁` and `t*₂` are `≥` some actor's `logicalStartTick`, with compatible selectors targeting the same actor population. The earliest-time rule (Step 1 of tie-breaking) resolves this — the earlier tick wins, regardless of selector compatibility — so this specific case is handled correctly by the engine. True ambiguity (identical ticks) is prevented by the monotonic clock.

**Documentation vs. guarantee gap:** The formal theorem's premise (well-formed registry) is satisfied in practice but not mechanically enforced. A future improvement would validate selector compatibility at registration time and return HTTP 409 for ambiguous configurations.

---

### Symbol Table Accuracy

The exported functions in Section 8 match what `src/ffi/engine.js` calls; `make -C src/ffi check` verifies the ones StateKeep needs.

### Actor archival

`gc-worker.js` runs on a 60-second loop, archiving actors idle for more than 24 hours, in batches of 500. Archival doesn't touch the routing registry: archived actors still count toward the collection frontier, so they can be restored and routed.

---

## 16. Notation Reference

| Symbol | Meaning |
|---|---|
| `T` | Totally ordered logical time set (N+) |
| `S` | Set of machine states |
| `V` | Set of all versions |
| `C` | Set of all registered change-points |
| `v : T → S` | A version (actor execution trace) |
| `Pref(v, t)` | History of v strictly before t |
| `[v]_t` | History-prefix class of v at t |
| `v ≡_t w` | v and w share history before t |
| `(t*, P, r)` | Change-point: deployment time, prefix class, refinement |
| `Child(t*, P, r)` | New version created by change-point |
| `r_max(t*, P)` | Maximum refinement at location (t*, P) |
| `C+(T; v)` | Change-points at or after T applicable to v |
| `t*(T; v)` | Earliest applicable deployment time |
| `r*(T; v)` | Latest refinement at selected location |
| `Acc(v, T)` | Unique accessible version for actor v at time T |
| `Live(t*, P)` | Active actors carrying prefix P at t* |
| `APVClock` | Monotonic integer clock for deployment times |
| `h₀` | `SHA-256("statekeep.fp.v2|empty")`: start of the v2 fingerprint chain |
| `historyFingerprint` | Actor's current prefix class: `"2:<64 hex>"` (v2), `"0"` (empty), or 16-char hex (legacy v1) |
| `FNV_OFFSET`, `FNV_PRIME` | `0xcbf29ce484222325`, `0x100000001b3`: FNV-1a 64-bit, used for legacy v1 fingerprints and for family scopes (`scopeOf`) |
| `regionFingerprints` | Per-region fingerprint map for parallel machines |
| `logicalStartTick` | APV clock value at actor spawn (= T in Acc) |
| `tStar` | APV clock value at deployment (= t* in change-point) |
| `prefixHash` | 64-bit engine key of a fingerprint (first 64 bits of the v2 digest; the value itself for v1) |
