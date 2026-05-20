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

## What is NOT supported

### Guards

Guards in transition definitions are parsed and stored but **never evaluated**. Every transition fires unconditionally — the first matching event wins.

```json
{
  "on": {
    "APPROVE": {
      "target": "approved",
      "guard": "isEligible"
    }
  }
}
```

StateKeep will take this transition regardless of `isEligible`. **Do not rely on guards to protect transitions.** Move that logic to your own backend before sending the event.

### Actions and services

Entry/exit actions, transition actions, and invoked services are ignored:

```json
{
  "entry": ["logEntry", "sendNotification"],
  "invoke": { "src": "fetchCreditScore" }
}
```

StateKeep will store these fields and advance the actor's state correctly, but it will **not execute** the actions or invoke the service. Your backend owns side effects — read the returned `stateValue` and act accordingly, or configure a webhook.

### XState `setup()` / TypeScript-native syntax

XState v5 encourages a `setup({ guards, actions, actors })` call that wires implementations inline with TypeScript functions:

```typescript
// This does NOT work with StateKeep
import { setup } from 'xstate';

const machine = setup({
  guards:  { isEligible: ({ context }) => context.score > 700 },
  actions: { notify:     ({ context }) => sendEmail(context.email) },
}).createMachine({ initial: 'submitted', states: { … } });
```

StateKeep cannot receive TypeScript functions over HTTP. To use a machine defined this way with StateKeep, extract the JSON config and strip the implementations:

```typescript
// Extract the plain config object
const config = {
  initial: 'submitted',
  states: {
    submitted: { on: { APPROVE: 'approved' } },
    approved:  { type: 'final' },
  },
};

// Deploy the config — guards/actions are handled by your backend
await client.deployDefinition({ id: 'loan-machine', machineDefinition: config });
```

## Recommended pattern

1. **Define structure in JSON** — states, transitions, and hierarchy live in StateKeep.
2. **Implement logic in your backend** — check eligibility before calling `sendEvent`; respond to `stateValue` to trigger downstream actions.
3. **Use webhooks for async work** — register `POST /v1/webhooks` to receive `actor.transitioned` events and run background jobs.

```
Customer backend                   StateKeep
──────────────────────────────────────────────────
 1. Check guard logic locally
 2. Call POST /v1/actors/:id/event ──────────────► advance state
 3. Read stateValue in response   ◄──────────────
 4. Execute action (email, DB) ◄─── OR use webhook
```

## Why this design

StateKeep's value is **state persistence, migration, and multi-version routing** — not running arbitrary customer code. Keeping the engine pure JSON means definitions are versionable, diffable, and migratable without code execution. Guards and actions belong in the customer's backend where they have access to secrets, databases, and the full application context.
