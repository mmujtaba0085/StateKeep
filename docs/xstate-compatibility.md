# XState Compatibility

StateKeep accepts state machine definitions as plain JSON objects — the same format XState v5 uses for its `config` parameter.

## What is supported

StateKeep parses and stores the structural parts of an XState config:

```json
{
  "id": "loan-application",
  "initial": "submitted",
  "states": {
    "submitted": { "on": { "APPROVE": "approved", "REJECT": "rejected" } },
    "approved":  { "on": { "DISBURSE": "disbursed" } },
    "rejected":  { "type": "final" },
    "disbursed": { "type": "final" }
  }
}
```

The following config fields are stored and used:

| Field | Support |
|---|---|
| `id` | Stored (display only) |
| `initial` | Used — sets the starting state |
| `states` | Used — full nested state hierarchy |
| `on` (transitions) | Used — event → target routing |
| `type: "final"` | Used — marks terminal states |
| `type: "parallel"` | Stored — parallel regions respected |
| `history` | Stored — used for APV fingerprinting |
| `stateMapping` | Used — renamed-state migration |
| `historyPath` / `historyRegions` | Used — APV migration targeting |

## Guards, actions and services

Guards, actions and invoked services **are executed**. Their implementations live outside
the definition, so the definition stays plain JSON: versionable, diffable and migratable.

| Where an implementation comes from | How |
|---|---|
| Expression guards | `"guard": "cond:amount < 1000000"`, evaluated by StateKeep with no code and no registry ([grammar](../src/runtime/conditionGuards.js)) |
| A local JavaScript module | `STATEKEEP_REGISTRY_PATH=/path/registry.js` exporting `{ guards, actions, services }`. Wrap side-effecting actions with `StateKeep.durable(fn, { delivery })` ([side effects](side-effects.md)) |
| Your own service, any language | `STATEKEEP_REMOTE_URL` + `STATEKEEP_REMOTE_SECRET`: guards and actions over signed HTTP ([remote implementations](remote-implementations.md)) |

```json
{
  "on": { "APPROVE": { "target": "approved", "guard": "isEligible" } },
  "entry": ["sendNotification"],
  "invoke": { "src": "fetchCreditScore" }
}
```

How they behave:

- **Guards** decide transitions. A guard that throws, times out, or has no implementation
  evaluates to **false** (fail closed), so a guarded transition is never taken by accident.
- **Actions** run as durable jobs, queued in the same transaction as the transition. Each
  action has a **delivery mode** (`idempotent`, `verify`, ...). An action whose outcome is
  unknown after a crash is never silently repeated: it's retried only when that's safe,
  otherwise it goes to human review ([side effects](side-effects.md)).
- **Invoked services** run while their state is active. Their result is sent back to the
  actor as an event.
- **Deploy-time check:** when a registry or remote service is configured, a definition that
  names a guard or action that exists in neither is rejected with `422` (this catches
  typos). Malformed `cond:` expressions are always rejected.
- **No implementations configured:** if neither `STATEKEEP_REGISTRY_PATH` nor
  `STATEKEEP_REMOTE_URL` is set, named guards evaluate to false and named actions do
  nothing. The server logs a warning at start-up. `cond:` guards still work.
- **Migration** restores an actor into its landing state **without running entry
  actions**, so a migration never fires side effects. See [APV: what a migration does](apv.md#what-a-migration-does-and-does-not-do).

### XState `setup()` / TypeScript-native syntax

XState v5's `setup({ guards, actions, actors })` wires implementations inline as
functions. Functions can't be sent over HTTP, so split the machine in two:

```typescript
// 1. The config (plain JSON) is what you deploy
const config = {
  initial: 'submitted',
  states: {
    submitted: { on: { APPROVE: { target: 'approved', guard: 'isEligible' } } },
    approved:  { entry: ['notify'], type: 'final' },
  },
};

// 2. The implementations go in your registry module (or remote service)
export const guards  = { isEligible: ({ context }) => context.score > 700 };
export const actions = { notify: StateKeep.durable(({ context }, { jobId }) =>
  mail.send(context.email, { idempotencyKey: jobId }), { delivery: 'idempotent' }) };
```

For in-process XState apps that don't use a StateKeep server, see
[`@statekeep/xstate-apv`](../packages/xstate-apv/), which keeps XState's own implementations.

## Context transforms on migration

When deploying a new definition version, you can include a `contextTransform` mapping to reshape an actor's context during migration. This is useful when context field names change between versions.

```json
PUT /v1/definitions
{
  "id": "loan-v2",
  "parentId": "loan-v1",
  "definition": { ... },
  "contextTransform": {
    "payment.verified": "feePaid",
    "applicant.name":   "userName"
  }
}
```

Rules:
- **Additive only** — new fields are added; old fields are preserved. Migrated actors will have both `feePaid` and `payment.verified` in their context.
- **Dot-notation paths** — both source and destination paths use dot-notation. Intermediate objects are created as needed.
- **Missing source paths are silently skipped** — no error if the old field doesn't exist on a specific actor's context.
- **Failed transforms tag actors `needs_rescue`** — if the transform throws (e.g. context is not an object), the actor is tagged and migration is aborted for that actor.
- **Fingerprint is unchanged** — context reshaping never alters the actor's APV history fingerprint.

## Event history pruning

By default, StateKeep retains all events forever. To cap storage growth, set `STATEKEEP_MAX_EVENT_HISTORY_DAYS` in your environment:

```env
STATEKEEP_MAX_EVENT_HISTORY_DAYS=90
```

The `gc-worker` process will prune events older than this threshold on each GC cycle.

> [!WARNING]
> Pruning is off by default. Once it is on, the event history is **no longer a complete
> audit log**, and an actor's history can no longer be replayed to its current state.
> Routing is not affected: it uses each actor's stored fingerprint, not its log.

The following lifecycle events are **always retained** regardless of age:

- `SPAWN`
- `MIGRATED`
- `MIGRATION_FAILED`
- `SCHEDULED_EVENT_FIRED`
- `SCHEDULED_EVENT_FAILED`
- `MANUALLY_RESCUED`

## Why this design

StateKeep's job is **state persistence, migration and multi-version routing**, and it runs
your guards and actions as part of that. The definition holds only structure and the
*names* of implementations. The code lives in your registry module or your own service,
next to your secrets and databases. This split keeps definitions plain data that can be
diffed, reviewed in a pull request and migrated, while the engine controls *when* and *how
safely* each side effect runs (durable jobs, delivery modes, human review).
