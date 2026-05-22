# @statekeep/sdk

TypeScript client for StateKeep — a statechart hosting platform that
runs XState-compatible state machines as persistent actors over HTTP,
with path-based migration when workflow definitions change.

## Installation

```
npm install @statekeep/sdk
```

## Quickstart

```js
import { createClient } from '@statekeep/sdk';

const sk = createClient({
  baseUrl: 'https://your-statekeep-instance.com',
  apiKey:  'sk_...',
});

// Deploy a machine definition
await sk.deploy('order-v1', {
  id: 'order', initial: 'pending',
  states: {
    pending:   { on: { PAY: 'paid', CANCEL: 'cancelled' } },
    paid:      { on: { SHIP: 'shipped' } },
    shipped:   { type: 'final' },
    cancelled: { type: 'final' },
  },
});

// Spawn an actor
const actor = await sk.spawn('order-v1', { orderId: 'ord-001' });

// Send events
const state = await sk.send(actor.actorId, 'PAY');
console.log(state.stateValue); // 'paid'

// Read state
const current = await sk.getState(actor.actorId);
```

## What StateKeep does and does not do

StateKeep tracks state transitions. It does NOT execute your
guard functions or action handlers.

Guards (`guard: 'myGuard'`) are stubbed to false — guarded transitions
never fire. Actions (`actions: 'sendEmail'`) are no-ops — state
transitions happen but nothing executes.

Your backend owns side effects. Read `stateValue` from the `send()`
response and execute side effects in your own code, or register a
webhook for `state.changed` notifications.

See the full compatibility guide at `docs/xstate-compatibility.md`
in the StateKeep repository.

## Handling deployment confirmation

If a deployment would strand actors in removed states, `deploy()` throws
a `StateKeepError` with code `'REQUIRES_CONFIRMATION'`. The `error.body`
contains `confirmToken`, `strandedActors`, and `safeActors`. Re-deploy
with that `confirmToken` to proceed:

```js
import { StateKeepError } from '@statekeep/sdk';

try {
  await sk.deploy('order-v2', definition, { parentId: 'order-v1' });
} catch (err) {
  if (err instanceof StateKeepError && err.code === 'REQUIRES_CONFIRMATION') {
    const { confirmToken, strandedActors } = err.body;
    console.log(`${strandedActors.length} actor groups will be stranded`);
    await sk.deploy('order-v2', definition, {
      parentId: 'order-v1',
      confirmToken,
    });
  }
}
```

## Idempotent event dispatch

Pass an `idempotencyKey` to prevent duplicate processing:

```js
await sk.send(actorId, 'PAY', {}, 'payment-txn-001');
// Calling again with the same key returns the current state
// without re-processing the event
```

## Error handling

```js
import { StateKeepError } from '@statekeep/sdk';

try {
  await sk.send(actorId, 'PAY');
} catch (err) {
  if (err instanceof StateKeepError) {
    console.error(err.status, err.code, err.message);
  }
}
```

## Limitations

- State machine definitions must be plain JSON. XState v5 `setup()` syntax with
  inline TypeScript functions is not supported — see
  [docs/xstate-compatibility.md](../docs/xstate-compatibility.md).
- Guards and actions in definitions are never evaluated. StateKeep always takes
  the first matching transition. Move guard logic to your backend before calling
  `send()`.
- The SDK has zero runtime dependencies and requires Node.js ≥ 18 (uses global
  `fetch`).
