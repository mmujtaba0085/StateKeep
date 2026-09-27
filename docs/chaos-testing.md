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
