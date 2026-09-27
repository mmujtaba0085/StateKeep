# Side effects: never silently repeated

**The guarantee:** StateKeep never silently repeats a side effect. Every action is either
protected against duplicates, or it stops and asks a human.

## Why "just exactly once" is impossible

Say StateKeep sends "charge card" to a service and the server crashes before the answer
arrives. After the restart, nobody knows whether the card was charged. There are only
two options: send it again and risk a double charge, or don't and risk no charge. No
engine can avoid this on its own. What StateKeep does is handle that moment explicitly,
per action, instead of guessing.

## What StateKeep tracks

| Moment | What is recorded |
|---|---|
| Before an action is sent | `started_at`, committed **before** the call |
| The implementation answers | `outcome = succeeded` + its answer, then the follow-up event |
| Follow-up event (`{"send": {...}}`) | delivered with idempotency key `job:<id>` → lands **exactly once**, even across crashes |
| Error that proves nothing happened (connection refused, DNS failure, HTTP 4xx, a local function throwing) | `started_at` cleared → safe to retry in **every** mode |
| Sent, no answer (crash, timeout, connection reset, HTTP 5xx) | outcome unknown → the action's **delivery mode** decides |

Jobs are leased while they run, and the lease is renewed, so a long action is never picked up twice.

Retry budget: 10 attempts for `idempotent` actions (always safe to repeat), 5 for others,
with exponential backoff capped by `STATEKEEP_ACTION_BACKOFF_MAX_MS` (default 5 min). When
the budget runs out, `failed` is used only if no attempt could have happened; otherwise
the job goes to review.

## Delivery modes

| Mode | When the outcome is unknown | Use it for |
|---|---|---|
| `idempotent` | Sent again with the same `Idempotency-Key` (= job id) | APIs that dedupe on a key: Stripe, most payment and email APIs, your own service with a unique constraint |
| `verify` | StateKeep asks `POST /actions/{name}/status` → `done: true` (keeps the answer) / `false` (runs it) / `null` (human) | Systems you can query: "was order 123 refunded?" |
| `at-most-once` **(default)** | Not repeated: job marked `unknown`, the actor gets `__SK_ACTION_UNKNOWN.{name}`, a human decides | Anything without dedupe or lookup: SMS gateways, legacy systems |

Declaring nothing gives the safe default. You opt in to automatic retry by saying the
action is idempotent or verifiable.

### Python SDK

```python
svc = ImplementationService(secret, job_store="jobs.sqlite")   # durable store → 'verify' by default

@svc.action("chargeCard", delivery="idempotent")
def charge(req):
    stripe.PaymentIntent.create(..., idempotency_key=req["jobId"])

@svc.action("refundOrder")
def refund(req): ...

@svc.verifier("refundOrder")                 # answer from the real system
def refund_happened(req):
    return any(r.metadata.get("job") == req["jobId"] for r in stripe.Refund.list(...))

@svc.action("sendSms", delivery="at-most-once")
def sms(req): ...
```

The SDK's job store records `started` before your function runs and `done` + the answer
after. A job left `started` (the service died mid-call) is only run again once StateKeep
says it is clear: a human resolved it as "did not happen", or the verifier answered
`done: false` (the request then carries `rerunApproved: true`). A retry of a finished job replays the answer, and a job still running answers `409`.
With a file-backed store, `status` answers `done: false` for jobs it has never seen, so
`verify` works. The in-memory store can't know about jobs from before a restart, so it
advertises `at-most-once` unless you declare otherwise.

### Local (JavaScript) actions

```js
StateKeep.durable(async ({ context }, { jobId }) => payments.charge(context, { idempotencyKey: jobId }),
  { delivery: 'idempotent' })
StateKeep.durable(fn, { delivery: 'verify', verify: async (args, { jobId }) => ({ done: await wasSent(jobId) }) })
```

## Human review

```bash
GET  /v1/action-jobs?outcome=unknown
POST /v1/action-jobs/<id>/resolve  {"happened": true, "event": {"type": "SMS_SENT"}}   # it went out
POST /v1/action-jobs/<id>/resolve  {"happened": false}                                # run it again
```

A job can be resolved once (a second attempt returns `409`). Handle
`__SK_ACTION_UNKNOWN.<action>` in the definition to park the case in a review state:

```json
"texting": { "entry": ["sendSms"], "on": { "SMS_SENT": "done", "__SK_ACTION_UNKNOWN.sendSms": "needs_review" } }
```

## Tested (`test/test_delivery.js`, real processes)

| Scenario | Result |
|---|---|
| Server `kill -9` mid-charge (idempotent) | Retried with the same key, charged once, `CHARGED` delivered once |
| Service dies right after refunding (verify) | StateKeep asks, the bank says done, no second refund |
| Server killed mid-call (verify via the SDK store) | "Still running", then "done", no repeat |
| Server killed mid-SMS (at-most-once) | Not re-sent; review queue; a human confirms; resolved only once |
| Request never answers (at-most-once) | Review; "did not happen", sent exactly once |
| Service down (connection refused) | Nothing was sent, so it's retried even in at-most-once |
| Action longer than the lease | Not started twice |

## What remains your responsibility

- **Idempotent** means the receiving system really dedupes on the key you pass it.
- **Verify** is only as good as your verifier's answer.
- Side effects inside a *local* function that throws after half its work are that
  function's to roll back: a throw is read as "did not happen".
