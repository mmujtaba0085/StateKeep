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
| A was only paused (GC pause, VM freeze, SIGSTOP) past the TTL and wakes up mid-event | Its writes are refused at commit: every takeover increments the actor's ownership generation, and a flush commits only writes made under the current one. The paused request gets `503 OWNER_CHANGED` (the event was not applied) — retry. |
| A deployment is made while a server is slow, paused or partitioned | Every event unit reads the registry epoch before routing and syncs first if its registry is older, so no event that starts after the deployment committed is routed without it |
| WebSocket stream on any server | Receives changes from every server (Postgres LISTEN/NOTIFY) |
| Scheduler, migrate-worker, action jobs | Go through the routed internal endpoints, so they reach the owner too |
| Stranding preview on one server, confirmation through another | Works: confirmation tokens are stored in the database |

Background workers (`migrate`, `scheduler`, `webhook`, `gc`, …) can run as one instance each, or
several — they claim work with row locks.

## Clocks

Nothing that decides correctness reads a clock:

- **Routing** is fenced by the registry epoch (a counter bumped by each deployment's commit).
- **Ownership** is fenced by the ownership generation (a counter bumped by each claim or takeover),
  checked with a share lock inside the commit, so a takeover waits for an in-flight commit and
  the old owner can never commit after it.
- **Deployment and spawn order** use the logical deployment clock (a database sequence).

Liveness — when a silent owner may be taken over — uses heartbeats compared on the
database's clock only, never across servers' wall clocks.

Time-based work — `after:` timers, scheduled events, action-job leases and retries — runs on
one time line: each server measures its offset to the database clock every few seconds
(`STATEKEEP_CLOCK_RESYNC_MS`, default 5000) and uses the corrected time. A server whose clock is
minutes off still fires timers on time and does not steal another server's action jobs. A
clock *drifting* in rate is corrected at every re-measurement.

Cost of the fences: one primary-key read per event (registry epoch) and one share-locked
read of the batch's ownership rows per group commit — about 12–15 % of cluster throughput
measured with two servers and Postgres on one machine. Single-server mode is unaffected.

## Tests

`test/cluster/cluster.test.js` (two servers, one database), with deterministic pauses
(`src/lib/testHooks.js` freezes a whole server at an exact instruction):
concurrent events split across both servers (no lost updates), idempotency across servers,
cross-server WebSocket notifications, owner killed mid-stream (every confirmed event kept),
restarted server not using stale state, a server frozen before / after its registry check
during a deployment, a server frozen mid-event and taken over (and mid-commit, where the
takeover must wait), stranding confirmation across servers. Each fence has a control test
that disables it and shows the scenario then fails.

`test/cluster/skew.test.js`: three servers, one 5 minutes behind and running slow, one
5 minutes ahead and running fast (`test/helpers/skewClock.mjs`): the same guarantees, plus
`after:` timers firing on time whichever server created them.

Separate machines: [multi-host-testing.md](multi-host-testing.md).
