# Chaos simulation

`test/chaos/simulate.mjs` runs StateKeep against real processes and injects faults at
random, each with its own probability. Several can happen at the same moment. After every
round it checks each case against a set of invariants, using ground truth recorded by the
service itself.

```bash
node test/chaos/simulate.mjs --seed 7 --rounds 12 --per-round 30 --backend sqlite
node test/chaos/simulate.mjs --backend postgres --db postgresql://…/empty_db
node test/chaos/simulate.mjs --backend cluster  --db postgresql://…/empty_db     # two API servers
node test/chaos/simulate.mjs --intensity hard …                                  # most attempts fail
```

The same seed gives the same plan (fault draws, client behaviour, timing offsets). The
report JSON lists every case with its faults, the requests the service received, its
attempts, the human decisions and any violations. Server and service logs are in the
printed directory.

## What is simulated

**A case** is one payment actor that runs one side-effecting action. The four actions
cover the delivery modes (`docs/side-effects.md`):

| Event | Action | Delivery |
|---|---|---|
| CHARGE | chargeCard | idempotent (the "bank" dedupes on the job id) |
| REFUND | refundOrder | verify (a verifier asks the bank) |
| NOTIFY | notifyPartner | verify (the SDK's job store answers) |
| SMS | sendSms | at-most-once |

**Per attempt** (independently for attempts 1, 2, 3; later attempts are `ok`):

| Fault | Normal | Hard | What happens |
|---|---|---|---|
| ok | 45% | 15% | effect, answer |
| slow | 15% | ↑ | 0.3–1 s, below the timeout |
| error_4xx | 12% | ↑ | rejected, nothing happened |
| late_success | 8% | ↑ | the effect happens *after* StateKeep's timeout |
| hang_no_effect | 7% | ↑ | no answer, no effect |
| crash_after | 7% | ↑ | the **whole service** dies right after the effect |
| crash_before | 6% | ↑ | the **whole service** dies before the effect |

A crash kills every call in flight, so one case's crash is collateral damage for others.

**Per round** (independent; any combination can fire at random moments):

| Global fault | Normal | Hard |
|---|---|---|
| API server `kill -9` (in cluster mode, a random node) | 35% | 77% |
| Service crash (restarted by a supervisor) | 25% | 55% |
| Service outage, 2–6 s | 20% | 44% |
| Live migration to a new definition version | 15% | 33% |
| Burst of concurrent events to the round's actors | 20% | 44% |

**Clients:** duplicate requests with the same idempotency key (25%), extra events at the
same moment (20%), and retries until the server answers.

**Human review:** after each round a simulated reviewer works the review queue until it
is empty, answering from ground truth *at that moment*: "it happened" (with the follow-up
event) or "it did not" (re-run).

## Invariants (every case)

1. No side effect happens twice (ground truth: the bank's and the gateway's records)
2. `done` ⇒ exactly one effect
3. `failed` ⇒ zero effects (failed promises it did not happen)
4. The follow-up event appears at most once in the actor's history
5. Nothing is stuck in a working state
6. Nothing is left in review once the reviewer is done
7. A confirmed request is never lost

## Bugs it found (all fixed)

| Bug | Scenario that exposed it |
|---|---|
| A human's "did not happen" re-run was refused forever by the SDK | The service died mid-call, so its job store said "started" |
| A re-run after review started with no retries left | The earlier retry count carried over |
| `failed` although the effect had happened | idempotent: attempt 1 unanswered, attempt 2 rejected, attempt 3 timed out |
| **A durable action was silently dropped** | A server restarted **during a service outage** could not fetch the manifest, so it did not recognise the action; the transition committed with no job and the case waited forever |
| The same outage made remote guards count as "missing" | as above (they now fail closed) |
| An action with no implementation marked failed without telling the actor | the actor stayed in its working state |

---

# Generic workflow simulation

`test/chaos/workflow/simulate.mjs` (`npm run chaos:workflows`) is not tied to one kind of
system. Each run generates workflows for several unrelated domains — orders, CI pipelines,
support tickets, IoT devices, clinical trials, insurance claims, hiring, content moderation —
with random structure: nested states, a parallel block, guarded and eventless transitions,
timers, entry actions with side effects (each with its own delivery mode and follow-up
event) and final states. It then evolves them into new versions mid-flight, as teams do:
add a step, rename a state (with a `stateMapping`), reroute a transition only for actors that
took a specific history (`historyPath`, picked from real live actors), copy a context field.

```bash
node test/chaos/workflow/simulate.mjs --seed 7 --rounds 10 --per-round 30 --backend sqlite
node test/chaos/workflow/simulate.mjs --backend postgres|cluster --db postgresql://…/empty_db
node test/chaos/workflow/simulate.mjs … --intensity hard
```

**Faults, several at once, at any point of any workflow:**

| Where | Faults |
|---|---|
| Each action attempt | slow · rejected · succeeds after the timeout · hangs · the service crashes before / after the effect |
| Each round | API server `kill -9` · service crash · service outage · migrate-worker kill · scheduler kill · all database connections dropped (Postgres) · 1–2 new versions deployed · event storms |
| Each client event | duplicates (same idempotency key) · concurrent sends · unknown events · payloads that flip guards |

**The oracle** (`oracle.mjs`) rebuilds every actor from its audit trail alone (spawn, every
recorded event, every `MIGRATED` marker) with StateKeep's own interpreter, in memory, where
none of the faults can reach, and compares it with the live actor. It also checks the APV
rules against the deployment log independently of the engine, and:

- every acknowledged request appears exactly once in the history
- no side effect happened twice; each follow-up was delivered at most once
- no action job is stuck; nothing is left in review; no timer is overdue or fired early
- no actor was stranded (`needs_rescue`) — no unmappable change is deployed
- a migration was justified by its `historyPath`, never went backwards or to another workflow,
  and moved the state the actor was actually in
- an actor matching a deployment did not keep processing events on the old version
  (clients mostly spawn with the family id, "newest version"; 20% pin the version they know)
- no actor exists that no client was told about (a refused or retried spawn)

The APV engine itself is covered by `test/test_apv_conformance.js`: thousands of random
operation sequences against a reference model of its rules.

## Bugs the workflow simulation found (all fixed)

| Bug | Scenario that exposed it |
|---|---|
| A targeted deploy queued batch migrations for actors of **other workflows** | two workflows deployed in the same round |
| A batch migration overwrote events processed meanwhile (lost update) | the migrate worker read an actor, the owner processed an event, the worker wrote its stale copy. Batch migrations now run on the owning server, under the actor's lock |
| Two servers could give two deployments the same t\*, and a server missed another's change-points | cluster mode, deploys on both nodes. t\* now comes from a database sequence; change-points are synced every 500 ms |
| **Acknowledged events lost** when the database connections dropped | a failed write-buffer flush discarded its batch while the in-memory state had moved on, and the error was swallowed, so the client got 200. Failed batches are now retried in order; a request is answered only after its rows commit |
| An actor spawned before a deployment could look newer than it | after a server restart the clock resumed from the last t\*, not from the last tick used; on Postgres t\* came from a sequence behind the event clock. The clock now resumes after every known tick, and "latest version" spawns are dated by their version |
| An inline migration of an actor just loaded from the database went on processing on the **old** version | server restart then a deploy; the next event migrated it twice |
| A migration could start from a database row older than the in-memory state | events buffered but not yet flushed; the migration now flushes first |
| A lost database connection crashed the server | the LISTEN client and a transaction client had no error handler |
| Timers and entry actions of the initial state never ran; an actor final at spawn stayed active | workflows whose first state has `after` / `entry` / is final |
| A follow-up event to a finished actor was retried forever | the action finished after the actor did |
| `SQLITE_BUSY` at start-up crashed the migrate worker | worker and server bootstrapping the schema at once |
| Gaps in the audit trail (migrations, timer events) | the history could not be replayed to the current state |
| **A deployment never reached some actors** | another workflow had deployed in between: the engine's change-point registry is global, its first answer belonged to the other workflow and was discarded, so the actor stayed. The lookup now falls back to the actor's own family |
| A timer was late by 30 s – 4 min after a server restart, and a finished actor's timer was retried for minutes | a failed delivery was treated like a faulty timer (30 s back-off, retries spent). Now: server unreachable → retry in 2 s, no retry spent; actor finished → the timer is cancelled |
| A retried spawn created a **second actor**; a crash right after a spawn lost its first jobs and timers | the server was killed while answering a spawn and the client retried. Spawns now take an idempotency key, and the actor, its first jobs, timers, `SPAWN` event and key are one transaction |
