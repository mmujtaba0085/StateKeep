# Running several API servers (cluster mode)

Postgres only. Every server can receive every request; each actor is owned by exactly one
live server, which is the only one that caches and writes it.

```bash
STATEKEEP_CLUSTER=true
STATEKEEP_DB_URL=postgresql://…              # shared database
STATEKEEP_NODE_URL=http://10.0.0.11:3001     # how the OTHER servers reach this one
STATEKEEP_ADMIN_KEY=…                        # same on all servers (internal calls)
STATEKEEP_NODE_TTL_MS=5000                   # owner considered dead after this long without a heartbeat
STATEKEEP_NODE_ID=api-1                      # optional; random if unset
```

Put the servers behind any load balancer — no sticky sessions needed.

## How it works

| Situation | What happens |
|---|---|
| Actor created on server A | A owns it |
| Request for that actor arrives at B | B forwards it to A (one hop, response header `x-statekeep-served-by: A`) |
| A crashes | After the TTL, the next request anywhere takes the actor over and reloads it from the database. Nothing acknowledged is lost: an event is only confirmed once it is committed. During the TTL, requests get `503 OWNER_UNREACHABLE` — retry. |
| A comes back | It sees it no longer owns those actors and forwards to the new owner; it never writes with its old cached copy |
| WebSocket stream on any server | Receives changes from every server (Postgres LISTEN/NOTIFY) |
| Scheduler, migrate-worker, action jobs | Go through the routed internal endpoints, so they reach the owner too |

Background workers (`migrate`, `scheduler`, `webhook`, `gc`, …) can run as one instance each, or
several — they claim work with row locks.

Tested with two servers (`test/cluster/cluster.test.js`): concurrent events split across both
servers (no lost updates), idempotency across servers, cross-server WebSocket notifications,
owner killed mid-stream (every confirmed event kept), restarted server not using stale state.
