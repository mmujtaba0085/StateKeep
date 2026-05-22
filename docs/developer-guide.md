# StateKeep Developer Guide

This guide is for backend developers integrating StateKeep into their applications. It covers everything from your first API call to advanced migration patterns.

---

## What StateKeep does for your app

You define your workflows as JSON state machines. StateKeep runs them as persistent actors — one instance per order, loan, user, or whatever your domain entity is. Your backend sends events and reads state over HTTP. StateKeep handles persistence, history, encryption, version migration, and garbage collection.

**What you own:** side effects — sending emails, charging cards, calling APIs.  
**What StateKeep owns:** current state, event history, transitions, version upgrades.

When you need to change a workflow (add a step, rename a state, reroute certain users), you deploy a new definition version. StateKeep decides which in-flight actors migrate to the new version based on their event history — not just where they currently are. Actors that should stay on the old version keep running normally with no intervention from you.

---

## Prerequisites

- An API key (`sk_...`) and a base URL
- Node.js ≥ 18 for the SDK, or any HTTP client for raw API access
- Basic familiarity with state machines (states + transitions)

---

## SDK Quickstart

```bash
npm install @statekeep/sdk
```

```js
import { createClient } from '@statekeep/sdk';

const sk = createClient({
  baseUrl: 'https://your-statekeep-instance.com',
  apiKey:  'sk_...',
});

// 1. Deploy a workflow definition
await sk.deploy('order-v1', {
  id: 'order', initial: 'pending',
  states: {
    pending:   { on: { PAY: 'paid', CANCEL: 'cancelled' } },
    paid:      { on: { SHIP: 'shipped' } },
    shipped:   { on: { DELIVER: 'delivered' } },
    delivered: { type: 'final' },
    cancelled: { type: 'final' },
  },
});

// 2. Spawn an actor for a specific order
const actor = await sk.spawn('order-v1', { orderId: 'ord-001', userId: 42 });
console.log(actor.actorId, actor.stateValue); // act-uuid, 'pending'

// 3. Send events as things happen in your system
const state = await sk.send(actor.actorId, 'PAY', { method: 'card', amount: 99.99 });
console.log(state.stateValue); // 'paid'

// 4. Read state at any time
const current = await sk.getState(actor.actorId);

// 5. Terminate when done
await sk.terminate(actor.actorId);
```

---

## HTTP Quickstart

For non-Node backends, use any HTTP client.

```bash
BASE="https://your-statekeep-instance.com"
KEY="sk_..."

# Deploy a definition
curl -sX PUT "$BASE/v1/definitions" \
  -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  -d '{
    "id": "order-v1",
    "definition": {
      "id": "order", "initial": "pending",
      "states": {
        "pending":   { "on": { "PAY": "paid", "CANCEL": "cancelled" } },
        "paid":      { "on": { "SHIP": "shipped" } },
        "shipped":   { "type": "final" },
        "cancelled": { "type": "final" }
      }
    }
  }'

# Spawn an actor
ACTOR=$(curl -sX POST "$BASE/v1/actors" \
  -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"definitionId":"order-v1","initialContext":{"orderId":"ord-001"}}' \
  | jq -r .id)

# Send an event
curl -sX POST "$BASE/v1/actors/$ACTOR/event" \
  -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"type":"PAY","payload":{"method":"card"}}'

# Read state
curl -s "$BASE/v1/actors/$ACTOR" -H "X-API-Key: $KEY"
```

---

## Designing Your State Machine

StateKeep accepts **plain JSON** compatible with XState v5 structure. Key rules:

```json
{
  "id": "machine-name",
  "initial": "state1",
  "states": {
    "state1": {
      "on": {
        "EVENT_NAME": "state2",
        "OTHER_EVENT": "state3"
      }
    },
    "state2": { "on": { "FINISH": "done" } },
    "state3": { "on": { "RETRY": "state1" } },
    "done":   { "type": "final" }
  }
}
```

**Rules:**
- `initial` must reference an existing state
- Every transition target must be an existing state
- Final states (`"type": "final"`) cannot have outgoing transitions
- No inline JavaScript functions — guards and actions are no-ops (see [XState Compatibility](xstate-compatibility.md))
- State names must be unique

**Soft warnings** (definition still stored):
- `DEAD_END_STATE` — non-final state with no outgoing transitions
- `UNREACHABLE_STATE` — no path from initial state
- `NO_TERMINAL_STATE` — no final states defined

Validate before deploying without committing:
```js
const result = await sk.validate(myDefinition);
if (!result.valid) console.error(result.errors);
```

---

## Deploying Definitions

### First deploy

```js
await sk.deploy('order-v1', definition);
```

The `id` is your permanent identifier for this version. Choose something meaningful: `order-v1`, `loan-approval-2026-05`, etc.

### Re-deploy (idempotent)

Deploying the same `id` with the same `definition` is a no-op:

```js
const r = await sk.deploy('order-v1', sameDef);
console.log(r.idempotent); // true — nothing changed
```

This makes CI/CD deploys safe to re-run.

### Dry-run preview before deploying

```js
const preview = await sk.preview('order-v2', newDef, { parentId: 'order-v1' });
console.log(preview.migration.wouldMigrate.length); // how many actors would move
console.log(preview.strandedActors);                 // actors that would be stranded
```

---

## Spawning and Managing Actors

### Spawn

```js
const actor = await sk.spawn('order-v1', {
  orderId: 'ord-001',
  userId: 42,
  tier: 'premium',
});
// actor.actorId — your handle for this instance
// actor.stateValue — 'pending' (the initial state)
```

The `initialContext` is any JSON object — store whatever your backend needs later. It's AES-256-GCM encrypted at rest.

### Bulk spawn

```js
// Spawn up to 500 actors in one request
const actors = [
  { definitionId: 'order-v1', initialContext: { orderId: 'ord-001' } },
  { definitionId: 'order-v1', initialContext: { orderId: 'ord-002' } },
];
const result = await fetch(`${base}/v1/actors/bulk`, {
  method: 'POST',
  headers: { 'X-API-Key': key, 'Content-Type': 'application/json' },
  body: JSON.stringify({ actors }),
});
```

### Read state

```js
const state = await sk.getState(actorId);
console.log(state.stateValue);  // current state name
console.log(state.context);     // current context object
console.log(state.status);      // 'active', 'terminated', 'needs_rescue', etc.
console.log(state.done);        // true if in a final state
```

---

## Sending Events

```js
const state = await sk.send(actorId, 'PAY', { method: 'card', amount: 99.99 });
```

If the event is not valid for the current state (no matching transition), the state doesn't change and `stateValue` remains the same.

### Idempotent dispatch

Pass an `idempotencyKey` to prevent duplicate processing — safe to retry on network failures:

```js
const state = await sk.send(actorId, 'PAY', payload, 'payment-txn-abc123');
// Sending again with same key returns current state without re-processing:
const same = await sk.send(actorId, 'PAY', payload, 'payment-txn-abc123');
console.log(same.idempotent); // true
```

Use your payment transaction ID, webhook delivery ID, or any unique request identifier as the key.

---

## Reading Event History

```js
const { events, hasMore, nextCursor } = await sk.getEvents(actorId, { limit: 50 });

// Paginate with cursor
if (hasMore) {
  const next = await sk.getEvents(actorId, { limit: 50, after: nextCursor });
}
```

System events in history:
- `SPAWN` — actor was created
- `MIGRATED` — actor migrated to a new definition version
- `MIGRATION_FAILED` — migration failed (actor is now `needs_rescue`)
- `SCHEDULED_EVENT_FIRED` — a scheduled event fired

---

## Upgrading State Machines (Migration)

### Additive changes (safe — no confirmation needed)

Adding new states, adding new transitions, or adding new events is always safe. Actors on the old definition are unaffected. Newly spawned actors can optionally target the new definition:

```js
await sk.deploy('order-v2', {
  // same states as v1 plus new 'review' state
  ...newDef,
  parentId: 'order-v1',
});
```

Actors already on `order-v1` continue there. New actors spawn on `order-v2`.

### Path-based routing (surgical migration)

Only actors whose event history contains a specific path migrate to the new version. Everyone else stays:

```js
await sk.deploy('order-v2', newDef, {
  parentId: 'order-v1',
  historyPath: ['PAY'],  // only actors who have paid get the new flow
});
```

This lets you roll out changes to the right segment without touching everyone.

### Breaking changes (confirmation flow)

If the new definition removes states that actors currently occupy, StateKeep blocks the deploy and returns a confirmation challenge:

```js
import { StateKeepError } from '@statekeep/sdk';

try {
  await sk.deploy('order-v3', newDef, { parentId: 'order-v2' });
} catch (err) {
  if (err instanceof StateKeepError && err.code === 'REQUIRES_CONFIRMATION') {
    const { confirmToken, strandedActors, safeActors } = err.body;
    console.log(`${strandedActors.length} state group(s) will be stranded`);
    console.log(`${safeActors} actors will migrate safely`);

    // If you're okay with stranding those actors:
    await sk.deploy('order-v3', newDef, { parentId: 'order-v2', confirmToken });
  }
}
```

Stranded actors (those in removed states) get `status: 'needs_rescue'` and return 409 on all events. You rescue them by either:
1. Deploying a rescue version with a `historyPath` targeting those actors
2. Manually resetting them via `sk.rescueActor(actorId)` (moves to active, same state)

### Renaming states (`stateMapping`)

When you rename a state in the new definition, tell StateKeep about the rename so actors don't get stranded:

```js
await sk.deploy('order-v2', newDef, {
  parentId: 'order-v1',
  stateMapping: { 'paid': 'payment_confirmed' },  // old → new
});
```

---

## Scheduled Events

Schedule a future event for an actor:

```js
// Fire in 1 hour
const sched = await sk.schedule(actorId, 'SEND_REMINDER', {
  delay: 60 * 60 * 1000,  // milliseconds from now
  payload: { message: 'Your order is waiting' },
});

// Or fire at a specific time
const sched = await sk.schedule(actorId, 'SEND_REMINDER', {
  fireAt: Date.now() + 3600000,  // unix ms timestamp
});

// Cancel before it fires
await sk.cancelScheduled(actorId, sched.id);
```

Scheduled events are automatically cancelled when an actor is terminated.

---

## Webhooks

Register an HTTPS endpoint to receive push notifications when actor state changes:

```js
await sk.createWebhook({
  url: 'https://yourapp.com/hooks/statekeep',
  secret: 'whsec_your_secret_min16chars',
  events: ['state.changed', 'actor.needs_rescue'],
});
```

**Verify incoming payloads** (Node.js example):

```js
import crypto from 'crypto';

function verifyWebhook(rawBody, signature, secret) {
  const expected = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');
  const received = signature.replace('sha256=', '');
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(received));
}

// In your webhook handler:
app.post('/hooks/statekeep', (req, res) => {
  const sig = req.headers['x-statekeep-signature'];
  if (!verifyWebhook(req.rawBody, sig, WEBHOOK_SECRET)) {
    return res.status(401).send('Bad signature');
  }
  const { eventType, data } = req.body;
  if (eventType === 'state.changed') {
    console.log(`Actor ${data.actorId} moved to ${data.currentState}`);
  }
  res.sendStatus(200);
});
```

Webhook events: `state.changed`, `actor.migrated`, `actor.terminated`, `actor.needs_rescue`, `scheduled.fired`, `scheduled.failed`

---

## Error Handling

```js
import { StateKeepError } from '@statekeep/sdk';

try {
  await sk.send(actorId, 'PAY');
} catch (err) {
  if (err instanceof StateKeepError) {
    console.error(err.status);  // HTTP status code
    console.error(err.code);    // error code string
    console.error(err.message); // human-readable message
  }
}
```

| Status | Code | Meaning |
|--------|------|---------|
| 404 | — | Actor/definition not found |
| 409 | — | Actor is terminated or needs_rescue |
| 429 | — | Rate limit exceeded |
| 200 | `REQUIRES_CONFIRMATION` | Breaking deploy needs confirmation |

**`needs_rescue` actors:** An actor in `needs_rescue` returns 409 on all events. This happens when it's stranded in a state that no longer exists in its definition. Options:
1. Deploy a rescue version targeting its history path
2. Call `sk.rescueActor(actorId)` to manually clear the status (actor stays in same state, which now maps to active)

---

## Rate Limits

| Tier | Requests/min | Max actors |
|------|-------------|-----------|
| Free | 100 | Unlimited |
| Pro | 1,000 | Unlimited |
| Enterprise | 10,000 | Unlimited |

Rate-limit headers on every response: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`.

---

## CLI

The StateKeep CLI lets you push definitions from files without writing curl commands.

```bash
npm install -g @statekeep/sdk  # CLI included with SDK
```

```bash
# Push all *.machine.js files in current directory
statekeep push . --url https://your-instance.com --key sk_...

# Preview migration impact before pushing
statekeep preview order-v2.machine.js --parent order-v1 --url https://... --key sk_...

# Development mode: watch + auto-push on file changes
statekeep dev --url http://localhost:3001 --key sk_...
```

Set `STATEKEEP_URL` and `STATEKEEP_API_KEY` env vars to avoid passing flags every time.

---

## Further Reading

- [API Reference](../API.md) — every endpoint with full request/response shapes
- [XState Compatibility](xstate-compatibility.md) — what's supported and what isn't
- [Getting Started Tutorial](getting-started.md) — step-by-step walkthrough with curl
- [SDK source](../sdk/src/index.ts) — TypeScript type definitions
