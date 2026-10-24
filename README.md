<div align="center">

# StateKeep

**Durable, versioned state machines — for workflows, and for AI agents that have to survive the real world.**

[![License](https://img.shields.io/badge/license-Apache%202.0%20%2B%20Commons%20Clause-blue)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22.0.0-339933?logo=node.js&logoColor=white)](package.json)
[![CI](https://img.shields.io/badge/CI-GitHub%20Actions-2088FF?logo=githubactions&logoColor=white)](.github/workflows/ci.yml)
[![XState v5 compatible](https://img.shields.io/badge/definitions-XState%20v5%20compatible-6b46c1)](docs/xstate-compatibility.md)
[![Self-hosted](https://img.shields.io/badge/deploy-self--hosted-black)](#quick-start)

[Quick Start](#quick-start) · [AI Agents](#-built-for-ai-agents) · [Features](#features) · [Docs](#documentation) · [Why Not Just Use X](#why-not-just-use-x)

</div>

---

Every long-running process — an order, a loan, a support ticket, an AI agent mid-conversation — is a state machine whether you modeled it that way or not. StateKeep lets you define it explicitly, run it as a persistent actor, and **change its logic while it's still running**, without replaying history, without downtime, and without a migration script that only breaks in production.

```bash
curl -X PUT localhost:3001/v1/definitions -d '{
  "id": "order-v1",
  "definition": { "id": "order", "initial": "pending", "states": {
    "pending": { "on": { "PAY": "paid" } },
    "paid":    { "type": "final" }
  }}
}'

curl -X POST localhost:3001/v1/actors -d '{"definitionId":"order-v1"}'
# → { "id": "a1b2c3", "stateValue": "pending" }

curl -X POST localhost:3001/v1/actors/a1b2c3/event -d '{"type":"PAY"}'
# → { "stateValue": "paid" }
```

That actor now **lives forever** — survives restarts, crashes, deploys — and when you ship `order-v2`, StateKeep decides, per actor, based on the exact path each one took, whether it should move. Two actors sitting in the same state can get different, both-correct routing decisions in the same deployment.

---

## 🤖 Built for AI Agents

An agent loop — *user message → model call → tool call → wait for human approval → reply* — is just a state machine with unusually expensive transitions. Model it as a StateKeep actor and the hard parts disappear:

```
idle ──USER_MESSAGE──▶ thinking (callModel)
                         │ REPLY ─────────────▶ idle
                         │ TOOL_CALL (refund) ──▶ awaiting_approval ─APPROVE─▶ running_tool ─▶ thinking
                         │ TOOL_CALL (other)  ──▶ running_tool              └─DENY──▶ thinking
```

| Problem with agent loops in production | What you get for free |
|---|---|
| Server restarts mid-conversation → lost context | Transcript and pending step are committed before an event is even acknowledged |
| Tool calls double-fire on retry | Every tool call carries a `jobId`; the SDK replays the first result instead of re-running it |
| "Human in the loop" means building your own queue | `awaiting_approval` is just a state. The session waits a week if it has to. Costs nothing while it waits |
| Policy changes ("refunds over $50 need approval") require a redeploy of running sessions | It's a `cond:` guard in the definition — reviewable in a pull request, versioned like everything else |
| Shipping a new system prompt means losing every in-flight session | Deploy `v2` with a `parentId`. Every live session — including ones sitting in `awaiting_approval` right now — picks up the new prompt and policy without losing its place or its transcript |
| "What did the agent actually do at 3am?" | Every model step, tool call, approval and denial is an immutable event in that actor's history |

A full working example — a refund agent, its v1→v2 upgrade mid-flight, and the tests proving a session survives `kill -9` of the server — is in [`examples/agent/`](examples/agent/) and [`docs/agent-sessions.md`](docs/agent-sessions.md).

---

## Features

- **🔀 Zero-downtime migration** — the APV (Anchor Point Versioning) engine routes every live actor to the right version of your definition based on the exact event path it took, not just its current state. No replay, no migration script.
- **🛡️ Stranded-actor protection** — deploying a version that removes a state actors currently occupy doesn't fail silently. You get a preview, a confirm token, and a rescue path.
- **⚙️ Durable workflows** — [`@statekeep/durable`](packages/durable) gives you code-first durable functions with history-based version routing, no YAML required.
- **📬 Delivery guarantees per action** — idempotent, verify-based, or at-most-once side effects. A charge, a refund notification, and an SMS don't need the same safety net, so they don't get charged the same cost.
- **🌐 Cluster mode** — multiple nodes, one registry, pause-safe visibility barriers so a deploy never races an actor's own lease.
- **🧩 Bring your own definitions** — importers for BPMN, Amazon States Language, and SCXML; an XState v5-compatible format; SDKs for [Go](sdks/go), [Python](sdks/python), and [JS](sdk/).
- **🔍 Full audit trail** — every transition, migration, and side effect is an immutable event row. Nothing is inferred after the fact.

---

## Battle-tested, not just unit-tested

Most workflow engines ship with unit tests and call it done. StateKeep additionally runs two **chaos-engineering campaigns** against real processes — real `SIGKILL`s, real crashed services, real mid-flight deployments — and checks every result against ground truth that's deliberately kept independent of the system under test. One campaign rebuilds every actor from its own audit log, using a second, in-memory replay of the interpreter, and diffs it against the live result.

On top of that, the routing model itself — the part that decides which actor goes where during a migration — is [formally verified in Lean 4](formal/), with the real runtime cross-checked against the proof.

```bash
npm run chaos            # fault-injected payment workflows: real crashes, real retries
npm run chaos:workflows   # the same, across 8 unrelated generated domains
```

Read [`docs/chaos-testing.md`](docs/chaos-testing.md) for how the fault injection and the independent oracle actually work.

---

## Why Not Just Use X?

| | Best at | What you still have to build |
|---|---|---|
| **Temporal** | Durable, code-heavy async workflows with compensating transactions | Versioning is tied to your function code, not a definition. Old workers stay alive until every in-flight workflow they own completes — there's no built-in way to migrate a running workflow onto new logic. |
| **Inngest** | Event-driven pipelines with minimal infra | No explicit state machine model or versioned definition concept — you build one inside a function if you need it. |
| **XState** | Modeling stateful logic, excellent DX and ecosystem | It's a library, not infrastructure. Persistence, actor lifecycle, and migration routing for *running* actors are still on you. |
| **StateKeep** | Treating the definition itself as versioned data, migrated surgically across live actors | — |

Use Temporal when the workflow *is* code. Use Inngest for zero-infra event pipelines. Use StateKeep when the definition is the product: it needs to be versioned, audited, and migrated as data — not replayed as a journal.

---

## Quick Start

```bash
# 1. Generate a secret
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# 2. Configure
cp .env.example .env   # set STATEKEEP_ENCRYPTION_KEY, STATEKEEP_ADMIN_KEY, STATEKEEP_API_KEY

# 3. Run
docker compose up -d

# 4. Check it's alive
curl http://localhost:3001/v1/health
# → {"status":"ok","engine":"wasm","db":"ok"}
```

No Docker? `npm install && node --env-file=.env src/api/server.js` works the same way — see [`docs/getting-started.md`](docs/getting-started.md) for the full walkthrough, including deploying a second version with path-based routing.

**Windows:** runs natively, no WSL required for the server itself — just run `npm install` from PowerShell, not WSL, so `better-sqlite3` gets the right prebuilt binary. Details in [`docs/deployment.md`](docs/deployment.md).

---

## Documentation

| | |
|---|---|
| [Getting Started](docs/getting-started.md) | Step-by-step first deployment, with curl examples |
| [Plain-English Overview](docs/simple-overview.md) | What StateKeep does, no technical background assumed |
| [API Reference](docs/API.md) | Every route, request/response shape, error code |
| [Anchor Point Versioning](docs/apv.md) | How the migration engine actually decides where an actor goes |
| [AI Agent Sessions](docs/agent-sessions.md) | Agent loops as durable actors, with a full working example |
| [Side Effects & Delivery Modes](docs/side-effects.md) | Idempotent / verify / at-most-once, and when to use which |
| [Remote Implementations](docs/remote-implementations.md) | Wiring your own services (any language) into actions |
| [Importers](docs/importers.md) | Bringing in BPMN, ASL, and SCXML definitions |
| [Multi-Server / Cluster Mode](docs/multi-server.md) | Running more than one node against one registry |
| [Chaos Testing](docs/chaos-testing.md) | How the fault-injection campaigns work |
| [Developer Guide](docs/developer-guide.md) | Integrating StateKeep into your backend |
| [Deployment](docs/deployment.md) | Production checklist, Windows setup, scaling notes |

---

## Contributing

StateKeep is built by a small team, in the open. Issues and PRs are welcome — see [`CONTRIBUTING.md`](CONTRIBUTING.md) to get a dev environment running.

## License

[Apache 2.0 with the Commons Clause](LICENSE). Use, modify, and self-host StateKeep freely. Selling StateKeep (or a modified version of it) as a hosted service requires a separate commercial agreement — reach out at [statekeep.support@gmail.com](mailto:statekeep.support@gmail.com).
