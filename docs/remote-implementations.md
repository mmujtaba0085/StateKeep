# Guards and actions in any language

Guards and actions can live in your own HTTP service — Python, Go, Java, .NET, anything —
instead of a JavaScript module loaded into StateKeep.

## Configure

```bash
STATEKEEP_REMOTE_URL=http://credit-service.internal:8080/statekeep
STATEKEEP_REMOTE_SECRET=<long random string, shared with your service>
STATEKEEP_REMOTE_TIMEOUT_MS=5000        # optional
```

Local (JavaScript registry) implementations always win; everything else is looked up in
your service's manifest.

## Your service implements three endpoints

| Endpoint | Returns |
|---|---|
| `GET  /manifest` | `{ "guards": ["isCreditOk"], "actions": ["sendOffer"] }` |
| `POST /guards/{name}` | `{ "result": true }` |
| `POST /actions/{name}` | `{}` or `{ "send": { "type": "OFFER_SENT", "offerId": "…" } }` |

Request body: `{ actorId, definitionId, state, context, event }`.
Every request is signed — verify it:

```
X-StateKeep-Timestamp: 1790240000000
X-StateKeep-Signature: sha256=HMAC_SHA256(secret, "<timestamp>.<raw body>")
```

A complete, dependency-free example is in `examples/remote-python/service.py`.

## Semantics

- **Deploy-time check**: a definition that names a guard/action that is neither local nor in
  the manifest is rejected with 422 (catches typos).
- **Guards** are evaluated before the transition, in parallel, for every guard the incoming
  event can reach, using the actor's pre-event context. Errors and timeouts evaluate to
  `false` (fail closed). Guards on `always` transitions that run after an action changed the
  context also see the pre-event context.
- **Actions** are durable: committed in the same transaction as the transition, retried with
  exponential backoff (5 attempts), then `__SK_ACTION_FAILED.<name>` is sent to the actor.
- **Feeding results back**: return `send` from an action; it is delivered to the actor as a
  follow-up event and its fields are merged into the context (e.g. `offerId`).

## Several servers on one database

Every API server polls the shared action-job queue. Give all servers that share a
database the same `STATEKEEP_REMOTE_*` settings (and the same local registry): a server
without an implementation for an action marks that job failed. A claimed job is leased
(`STATEKEEP_ACTION_LEASE_MS`, default 120 s); if its server dies, the job is claimed again
after the lease, with the same `jobId`.
