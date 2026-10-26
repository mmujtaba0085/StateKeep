# Anchor-Point Versioning (APV)

How StateKeep decides **which running actors move to a new version of a workflow, and
when**, without replaying their event logs.

> **Sources of truth.** The model and its proofs are in the paper *Anchor-Point Versioning:
> History-Targeted Live Migration of Long-Running Statechart Actors* (Muhammad Mujtaba Amjad,
> 2026). The core results are machine-checked in [`formal/`](../formal/) (Lean 4); its
> [README](../formal/README.md) maps each theorem to its Lean name. The routing code is
> tested against those definitions (`test/test_model_oracle.js`). Where this page
> simplifies, the paper and `formal/` are authoritative.

---

## Contents

1. [The problem](#1-the-problem)
2. [The model on one page](#2-the-model-on-one-page)
3. [What is guaranteed](#3-what-is-guaranteed)
4. [Writing a deployment](#4-writing-a-deployment)
5. [The history fingerprint](#5-the-history-fingerprint)
6. [Parallel regions](#6-parallel-regions)
7. [How routing runs in StateKeep](#7-how-routing-runs-in-statekeep)
8. [Several servers](#8-several-servers)
9. [The APV engine](#9-the-apv-engine)
10. [Persistence](#10-persistence)
11. [Collection](#11-collection)
12. [Performance](#12-performance)
13. [Limitations](#13-limitations)
14. [Notation](#14-notation)

---

## 1. The problem

Actors (running instances of a statechart) live for days or months. When the definition
changes, every running actor raises the same question: *should this one follow the new
version?* Two actors in the same state may have got there by different paths, and only
one of those paths may be what the new version was written for.

The usual answers each have a cost:

| Approach | Cost |
|---|---|
| Let old actors finish on the old version | The fix never reaches them |
| Replay the event log on the new version | Re-runs side effects (a second charge, a second email) unless every action is idempotent; cost grows with history length |
| Hand-written migration code per version | Has to be written, tested and kept for every change |

APV lets the author of a new version **state which running actors it is for**: every actor
of the workflow, or only the actors whose transition history is exactly a given sequence.
Each actor then gets exactly one target by a registry lookup, without replay and without
running any actions.

APV is a *routing* discipline. It decides **where** an actor goes, not whether the new
version is behaviourally right for it; the state mapping you provide decides where in the
new version it lands (§4).

---

## 2. The model on one page

**Actor.** An actor `a` has a definition `d_a` (its current version), a configuration `q_a`
(its active states), a context `x_a`, a transition history `σ_a`, a logical time `ℓ_a`
and a status (`active`, `finished` or `stranded`). Every definition belongs to a
**family** (one workflow, all its versions).

**History.** `σ_a` is the sequence of event types that caused a transition, from the
actor's first event. Events that are ignored or whose guard fails are not part of it;
system events (`SPAWN`, `MIGRATED`) never are. Delayed transitions (`after:`) are.

**Change-point.** Every deployment registers one change-point

```
c = (family, t, π, r, target)
```

* `t` — the deployment time, from a logical clock (never wall time);
* `π` — the **pattern**: the wildcard `*` (every actor of the family), or a non-empty
  history (only actors whose history is exactly `π`);
* `r` — refinement index (StateKeep always uses 1: versions are immutable);
* `target` — the new version.

**Routing rule (accessibility).** For an active or stranded actor `a`:

```
App(a) = { c | c.family = family(d_a),  c.t ≥ ℓ_a,  π_c = * or π_c = σ_a }
Acc(a) = the element of App(a) that is least by (t, exact-before-wildcard, higher r)
```

If `App(a)` is empty the actor stays. In words: **the earliest deployment of its own
workflow, at or after its logical time, whose pattern it matches.**

**Migration.** Routing an actor through `c` sets `d_a := target` and `ℓ_a := t_c + 1`, so
it can never be routed through `c` (or anything earlier) again. If the state mapping
places its configuration and the context transform succeeds, it continues there
(`active`); otherwise it is **stranded**: kept on the new version with its old state,
taking no events until a later deployment gives it a path.

**Units.** Work on one actor runs one unit at a time. An **event unit** first routes the
actor to a fixpoint (migrate, look again, until nothing applies or it is stranded), then
processes one event. A **background unit** only routes.

**Logical time and spawns.** A new actor starts at one past the newest committed
deployment of its family. After a migration it is one past the deployment it moved
through. So an actor is only ever routed by deployments made *after* the point it
reflects. The clock invariant that makes this work (deployment times dominate the logical
times of existing actors, called (D) in the paper) is met by drawing deployment times from
one database sequence under a per-family lock.

### Worked example

```
order-v1:  pending ─CONFIRM→ confirmed ─SHIP→ shipped ─DELIVER→ delivered
                └─HOLD→ on_hold ─RELEASE→ confirmed
```

Three actors, all in `confirmed`:

| Actor | History `σ` | Logical time |
|---|---|---|
| A | `[CONFIRM]` | 6 |
| B | `[HOLD, RELEASE]` | 6 |
| C | `[CONFIRM]` | 9 (spawned later) |

Deploy `order-v2` at `t = 8` with `historyPath: ["HOLD", "RELEASE"]` (a fix for orders
that went through a hold):

* **A** — history `[CONFIRM]` ≠ pattern: stays on v1.
* **B** — history equals the pattern, `8 ≥ 6`: moves to v2 before its next event.
* **C** — has logical time 9, after the deployment at 8, so v2 never routes it. A spawn
  by family id (`"definitionId": "order"`) starts on the newest version; an actor pinned
  to `order-v1` stays there.

A wildcard deployment at `t = 10` would move A and C (and B, from v2) to the new version.

---

## 3. What is guaranteed

| Guarantee | Meaning | Paper | Lean |
|---|---|---|---|
| Determinism | Every actor has exactly one routing answer for a given registry | Thm 3.4 | `determinism` |
| Monotone progress | Logical time and the deployment times an actor passes through only increase; routing to a fixpoint terminates and never revisits a version | Thm 4.2 | `chain_progress`, `run_progress`, `routeU_complete` |
| Completeness | Every running actor a deployment targets is routed through it in its **first unit after the commit**, or stranded at an earlier hop | Thm 5.2 | `completeness_scalar`, `completeness_plus_*` |
| Configuration safety | An active actor is always in a valid configuration of its definition; otherwise it is explicitly stranded | Thm 6.1 | `run_safe` |
| Exact stranding prediction | Before a deployment commits, StateKeep lists exactly which current actors it would strand | Prop 6.2 | (implementation) |
| Parallel order | The choice among regional change-points is a total order, and a registration rule keeps arbitrary tie-breaks from deciding outcomes | Thm 7.4, Prop 7.6 | `par_determinism`, `no_arbitrary` |
| Collection | Change-points below the frontier can be removed without changing any answer | Thm 8.1 | `acc_prune`, `frontier_persists` |
| Clock-free cluster | Visibility and per-actor serialization across servers hold whatever the servers' clocks and however long a server pauses | Prop 5.9 | (paper proof; tested by pause and skew tests) |

Completeness rests on three explicit assumptions, which StateKeep implements (§7, §8):
**serialization** (an actor's units run one at a time), **visibility** (every unit that
starts after a commit sees the change-point), and **liveness** (every actor a deployment
can route gets another unit).

---

## 4. Writing a deployment

All deployments go through `PUT /v1/definitions`.

### Every actor of the workflow (wildcard)

```http
PUT /v1/definitions
{ "id": "order-v2", "parentId": "order-v1", "definition": { … } }
```

No `historyPath` means the wildcard. Additive changes (new states, new transitions) need
nothing else: every actor's current state still exists.

### Only actors with a given history

```http
PUT /v1/definitions
{ "id": "order-v3", "parentId": "order-v2",
  "historyPath": ["HOLD", "RELEASE"],
  "definition": { … } }
```

The rule is **whole-history equality**, counted from the actor's first event:

| Actor history | Pattern `["HOLD","RELEASE"]` |
|---|---|
| `[HOLD, RELEASE]` (now) | moves, before its next event |
| `[HOLD]` (now), later `RELEASE` | moves when it reaches `[HOLD, RELEASE]`, before its next event after that |
| `[HOLD, RELEASE, SHIP]` | stays (already past the point) |
| `[CONFIRM, HOLD, RELEASE]` | stays (not a substring match) |

A delayed transition is written by state path and delay:
`["CONFIRM", { "after": "confirmed", "ms": 5000 }]`.

### Where actors land: `stateMapping`

Every active leaf state (one per parallel region) must exist in the new version or be
mapped. Keys may be dotted paths for nested states:

```json
"stateMapping": {
  "in_progress": "processing",
  "shipping.packing": "shipping.fulfilment"
}
```

Regions that are new in the target version start in their initial state. A leaf that can
be neither kept nor mapped, or two leaves that map into conflicting positions, strand
the actor; it is never placed in a wrong state.

### Reshaping context: `contextTransform`

```json
"contextTransform": {
  "customer.email": "email",                                  
  "currency":       { "value": "EUR" },                       
  "limits.daily":   { "from": "dailyLimit", "default": 1000 } 
}
```

Copy from an old path (skipped if absent), set a constant, or copy with a default. The old
fields are kept. Paths containing `__proto__`, `constructor` or `prototype` are refused.

### What a migration does and does not do

| A migration… | |
|---|---|
| keeps the actor's context (after `contextTransform`) and its history | ✅ |
| places the actor by `stateMapping` | ✅ |
| writes a `MIGRATED` audit event in the same transaction as the move | ✅ |
| cancels the old state's `after:` timers and schedules the landing state's | ✅ (timers are not side effects) |
| runs entry actions of the landing state | ❌ never |
| replays events | ❌ never |

Because entry actions never run, a migration never fires side effects. The flip side: an
entry action that v2 *adds* to a state is not run for actors that migrate into that state,
only for actors that enter it by a transition afterwards.

### Previewing and confirming stranding

```http
POST /v1/definitions/preview          { same body }       → who would migrate, stay, strand
PUT  /v1/definitions                  { same body }       → 200 requires_confirmation + confirmToken
PUT  /v1/definitions                  { …, "confirmToken": "…" }   → 201
```

If a deployment would strand actors, the first `PUT` writes nothing and returns the
stranded actors grouped by version and state, plus a `confirmToken`. The confirming `PUT`
**repeats the prediction under the family's deployment lock, immediately before the
commit**, and deploys only if every actor it would now strand was in your preview
(fewer is fine). Otherwise you get a fresh preview naming how many were not in it
(`notInPreview`). Tokens are one-time, expire (`CONFIRM_TOKEN_TTL_MS`, default 5 minutes),
are bound to the definition's content, and live in the database, so any server can
confirm them.

Actors that would match *later* (they have not reached the pattern yet) cannot be known
exactly at deploy time. For them StateKeep checks a sound sufficient condition over the
versions they can be on and reports what the mapping cannot place as a
`LATE_MATCHER_RISK` warning.

Every stranding emits the `actor.needs_rescue` webhook with `consented: true|false`.

### Rescue

A stranded actor takes no events. A later deployment whose pattern it matches (often a
wildcard that adds back or maps its state) routes it forward: stranded actors are routed
by background units, and a sweep (`STATEKEEP_STRANDED_SWEEP_MS`, default 60 s) makes sure
none is forgotten. `GET /v1/actors/needs-rescue` lists them.

---

## 5. The history fingerprint

An actor does not store its history for routing; it stores a fixed-size **fingerprint**
of it. Processing an event is one hash step; routing is one lookup.

### Encoding (v2): length-prefixed SHA-256 chain

```
h₀      = SHA-256("statekeep.fp.v2|empty")
hₙ₊₁    = SHA-256(hₙ ‖ u32be(len(eₙ)) ‖ utf8(eₙ))      eₙ = event type of the n-th transition
stored  = "2:" + hex(hₙ)                                ("0" = empty history)
```

* **Injective**: the length prefix separates events, so `[PAY, MENT_OK]` ≠ `[PAYMENT_OK]`.
  Two histories share a fingerprint only if SHA-256 collides.
* **Order-sensitive**: `[START, SUBMIT]` ≠ `[SUBMIT, START]`.
* **Event types only**, never payloads, so a pattern can be written down.
* **Constant size**: 32 bytes per actor, plus 32 per parallel region.

A deployment's `historyPath` is hashed by the same function
(`computeHistoryFingerprint`, `src/ffi/fingerprintChain.js`), so "fingerprint equals the
pattern's fingerprint" means "history equals the pattern". The chain runs where the event
is processed (`src/runtime/interpreter.js`), only for events that cause a transition.

```
SPAWN        → "0"
SUBMIT       → "2:0469950248f1874c…"   step(h₀, "SUBMIT")
VERIFY_DOCS  → "2:a47acd00ca67691b…"   step(…, "VERIFY_DOCS")
APPROVE      → "2:79cff0d92c527c44…"   = fingerprint of ["SUBMIT","VERIFY_DOCS","APPROVE"]
```

### Legacy encoding (v1)

Earlier builds used a 64-bit FNV-1a hash of the plain concatenation of event types, which
is not injective. New actors never get one. Code for v1 actors remains (upgrade from the
event log when provably exact, otherwise refuse ambiguous matches with
`LEGACY_HISTORY_AMBIGUOUS`; `src/runtime/legacyFingerprints.js`); a deployment that has no
v1 actors is unaffected by it.

---

## 6. Parallel regions

In a parallel state each region progresses on its own, so one history per actor is not
enough. Each **region** (a child of a parallel node, at any depth, named by its full path
such as `active.setup.payment`) has its own fingerprint, advanced only by events that
change that region.

```http
PUT /v1/definitions
{ "id": "order-v2", "parentId": "order-v1",
  "historyRegions": {
    "setup.payment":  ["PAY_INITIATED", "PAY_CONFIRMED"],
    "setup.shipping": ["ADDRESS_SET"]
  },
  "definition": { … } }
```

* **Selector.** The regions listed form the selector; the actor matches if **every** listed
  region's fingerprint equals its pattern (regions not listed are free). Each regional key
  hashes the region path in, so identical histories in two regions never match each other.
* **Only active regions match.** A region that is not active has no fingerprint; a region
  that becomes active starts from `"0"`.
* **Order.** Among applicable regional change-points: earliest time first, then the larger
  selector, then the higher refinement, then a fixed tie-break. This is a total order.
* **Registration rule.** A deployment whose selector could tie with an existing one at the
  same time (same size, compatible, different target) is refused with **409** (the engine
  returns `-2`), so tie-breaks never decide an outcome.
* **Combining with scalar routing.** Both registries are asked, and the **earlier** hit wins
  (a scalar hit wins a tie). `historyPath` and `historyRegions` are mutually exclusive on
  one deployment (400); for both conditions, deploy twice.

Completeness for regional deployments holds in a slightly weaker form: the actor is routed
through a deployment of the family at that same time with an equal or larger selector
(see `formal/README.md`, deviation 1).

---

## 7. How routing runs in StateKeep

| Model | StateKeep |
|---|---|
| Event unit | Before each event, the actor's owning server routes it to a fixpoint under a per-actor lock (`_sendEventLocked`, `src/runtime/actorManager.js`), then processes the event. The hop bound is the number of change-points, never a small constant. |
| Background unit | Each deployment queues a migration job for every actor of the family with a pending route, stranded ones included. `migrate-worker` sends each job to the owner's internal route (`POST /v1/internal/actors/:id/migrate`), which routes by the same function under the same lock. |
| Liveness | Active actors are also routed before their next event; a stranded-actor sweep runs at start-up and every minute. An event unit whose lookup fails is refused, never run unrouted. |
| `Acc⁺` | `computeRoute` asks the scalar and parallel registries in the actor's family scope and takes the earlier hit; every hit is confirmed against the full fingerprint (`src/runtime/routingRegistry.js`). |
| Logical time | `max(stored logicalStartTick, deployedAt(current version) + 1)`. |
| Deployment time | A database sequence drawn under a per-family advisory lock (PostgreSQL); the engine clock with a single writer (SQLite), restored at start-up. |
| Spawn | Logical time is one past the family's newest committed deployment, read under the family lock in shared mode. Spawning by family id chooses the newest version in the same critical section. |
| Migration | Actor row, `MIGRATED` audit event and timers are written in one transaction. |
| Stranding | Actor recorded on the target version with its old state and `needs_rescue`, plus a `MIGRATION_FAILED` event, in one transaction; webhook `actor.needs_rescue`. |
| Immutability | Re-deploying an id with a changed definition, mapping or transform returns 409 `VERSION_IMMUTABLE`. |

---

## 8. Several servers

In cluster mode (PostgreSQL, `STATEKEEP_CLUSTER=true`) every actor has one owning server;
other servers forward its requests. Two counters in the database make the model's
assumptions hold **without any clock**:

| Assumption | Mechanism | What happens on a slow or paused server |
|---|---|---|
| Visibility | **Registry epoch.** A deployment commits by incrementing `registry_epoch` after its change-point row is written. Every unit reads the epoch before routing and synchronises first if its registry is older. | A unit that reads the epoch after the commit always sees the deployment; one that read it before is ordered before the deployment. |
| Serialization | **Ownership generation.** Every claim or takeover increments `actor_owners.gen`. Every transaction that writes an actor share-locks its ownership row and commits only under the generation this server holds. | A server paused past the heartbeat timeout and taken over cannot commit its stale copy; its request answers `503 OWNER_CHANGED` (not applied, retry). A takeover waits for an in-flight commit and then sees it. |

Clocks decide only **when** a silent owner may be taken over (heartbeats compared on the
database clock) and when timers fire. Timers, retries and action-job leases use the
database's time line (`src/lib/clusterClock.js`), so a server minutes off fires them on
time. Details, tests and costs: [multi-server.md](multi-server.md); separate machines:
[multi-host-testing.md](multi-host-testing.md).

---

## 9. The APV engine

The registry runs in a WebAssembly module compiled from C (`src/ffi/apv-engine.mjs`, about
17 KB, inlined; no build step). It is required: without it the server does not start, and
`/v1/health` reports `"engine": "wasm"`.

The C source is not part of this repository. The module is traceable:
* its header records the compiler (zig 0.13.0, pinned), flags and the SHA-256 of the
  embedded WebAssembly;
* the build is reproducible byte for byte from the engine source;
* `make -C src/ffi check` confirms that it loads and has every export StateKeep uses;
* the rule it implements is the one proved in `formal/`, and it is tested against it
  (`test/test_model_oracle.js`, `test/test_engine_ex.js`, `test/test_apv_conformance.js`).

**Keys.**
* A v2 fingerprint's engine key is the **first 64 bits** of its digest. Every hit is
  confirmed against the full 256-bit fingerprint; a mismatch (two histories sharing a key)
  falls back to an exact scan, so a key collision costs a scan and never misroutes.
* Scalar key `0` is the wildcard; a real history never maps to 0.
* Regional keys hash the region path with the regional digest.
* **Scopes:** every change-point is registered in its family's scope (a 64-bit hash of the
  family id), and every lookup is in the actor's family scope, so one workflow's
  deployments can never answer for another's.

**Functions StateKeep uses.**

| C function | Purpose |
|---|---|
| `apv_registry_create` / `apv_registry_destroy` | Allocate / free the registry |
| `apv_clock_tick` / `apv_clock_now` / `apv_clock_advance_to` | Logical clock (advance, read, restore after restart) |
| `apv_register_changepoint_scoped` | Register a scalar change-point in a family scope |
| `apv_register_changepoint_parallel_scoped` | Register a regional change-point; returns `-2` for an ambiguous selector |
| `apv_compute_accessible_scoped_ex` | Scalar lookup; returns the target, the hit's time and the matched key |
| `apv_compute_accessible_parallel_scoped_ex` | Regional lookup; returns the target and the hit's time |
| `apv_collect_before_scoped` | Remove a scope's change-points below the collection frontier |
| `apv_fnv1a_init` / `_update` / `_final` | FNV-1a, for legacy v1 keys and family scope ids |

The unscoped variants (`apv_register_changepoint`, `apv_compute_accessible`, and their
parallel forms) are scope 0 and remain for compatibility. Registration is all-or-nothing
under out-of-memory; selectors are sets (duplicate regions are ignored); regional lookups
use a per-time index.

---

## 10. Persistence

| Where | What |
|---|---|
| `actors.history_fingerprint` | `"2:<64 hex>"`, `"0"` for an empty history, or a legacy v1 value |
| `actors.region_fingerprints` | `{"_v":2,"regions":{"<path>":"<fp>",…}}` for parallel machines; unversioned blobs are refused |
| `actors.logical_start_tick` | The actor's logical time (see §7 for how the effective value is computed) |
| `changepoints` | Scalar change-points: `t_star`, stored key (`'0'` = wildcard; the v2 key is derived from the stored `historyPath`), `refinement`, `child_def_id`, `collected_at` |
| `par_changepoints` | Regional change-points: `t_star`, region map, `refinement`, `child_def_id`, `collected_at` |
| `definitions` | Each version, with its `historyPath` / `historyRegions`, mappings and deployment time |
| `registry_epoch` | The commit counter of §8 |
| `actor_owners` | Cluster owner and generation per actor |
| `confirm_tokens`, `stranding_consents` | Stranding previews awaiting confirmation; consented actors per deployment |
| `migration_jobs` | Background units |

**Restart and other servers.** Every server rebuilds its in-memory registry from
`changepoints` and `par_changepoints` at start-up, then synchronises incrementally
(`NOTIFY`, a 500 ms poll and the epoch check before each unit). Synchronisation keeps a
low watermark plus the row ids above it, because rows of two families can become visible
out of id order.

---

## 11. Collection

The registry would grow with every deployment. For each family StateKeep computes the
**frontier**: the smallest logical time that any routable actor (active, stranded or
archived — archived actors can be restored) or any future spawn can have. No change-point
below the frontier can apply to anyone (Thm 8.1, `acc_prune`, `frontier_persists`), so it
is removed from every server's engine (`apv_collect_before_scoped`) and marked
`collected_at` (every `STATEKEEP_COLLECT_INTERVAL_MS`, default 60 s).
`GET /v1/admin/registry?family=` shows the live and collected rows.

---

## 12. Performance

Measured on 2 vCPUs, Node.js 22; scripts and raw outputs are with the paper (`bench/`).

| Measure | Result |
|---|---|
| Registry lookup | about 1 µs per actor, independent of history length |
| Full routing decision, incl. fingerprint confirmation | about 2.7 µs (about 7 µs with two active regions) |
| Compliance check by replay, for comparison | 18 µs at 10 events, 7.4 ms at 5,000 events |
| Storage per actor | 32 bytes, plus 32 per parallel region |
| Cluster fencing (§8) | about 12–15 % of cluster event throughput; nothing for a single server |

A regional lookup with no match inspects the regional change-points at or after the
actor's logical time; collection bounds that set by what live actors can still reach.

---

## 13. Limitations

| Limitation | Practical meaning |
|---|---|
| Patterns are event **types**, not event data | You can target `PAY → SHIP`, not "orders over $500". Equal histories can sit in different states when guards read context, so the mapping must cover all of them. |
| Only exact histories and the wildcard | No prefix or "ever visited `on_hold`" patterns yet. |
| `historyPath` and `historyRegions` can't be combined | Deploy twice. |
| Mappings are checked for **placement**, not intent | StateKeep makes sure every state is placed somewhere valid; whether that is the right place is the author's call. |
| Consent window | An actor whose state changes in the instant between the final stranding check and the commit can be stranded without having been in the preview. It is reported (`consented: false`), not prevented. |
| New entry actions don't run on migrated actors | See §4. |
| Code tested, not proved | Lean proves the model; the routing code is checked against it on generated cases. The cluster protocol (§8) has a paper proof and pause/clock-skew tests. |
| Evidence so far | Generated workflows on single hosts (with skewed clocks simulated per process); no production case study yet. |

---

## 14. Notation

| Symbol | Meaning |
|---|---|
| `d_a`, `q_a`, `x_a` | Actor's definition (version), configuration, context |
| `σ_a` | Actor's transition history (event types that caused a transition) |
| `ℓ_a` | Actor's logical time |
| `f`, `wff(d)` | Family (workflow) of a definition |
| `c = (f, t, π, r, d')` | Change-point: family, deployment time, pattern, refinement, target |
| `*` | Wildcard pattern |
| `App(a)`, `Acc(a)` | Applicable change-points; the chosen one (`⊥` = stay) |
| `Acc⁺` | Combined scalar and regional routing (earlier hit; scalar on ties) |
| `μ`, `τ` | State mapping, context transform |
| `H(σ)` | Fingerprint of a history (v2 chain above) |
| `(D)` | Clock invariant: a deployment's time is ≥ the logical time of every actor it can route |
| `Φ_f` | Collection frontier of family `f` |
| `E`, `g` | Registry epoch; ownership generation (cluster) |
