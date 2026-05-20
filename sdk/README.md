# @statekeep/sdk

TypeScript client SDK for the [StateKeep](https://github.com/mmujtaba0085/StateKeep) Actor Lifecycle API.

## Installation

```bash
npm install @statekeep/sdk
```

## Quick start

```typescript
import { StateKeepClient } from '@statekeep/sdk';

const client = new StateKeepClient({
  baseUrl: 'https://statekeep.161-97-163-210.nip.io',
  apiKey:  'sk_live_...',
});

// 1. Deploy a state machine definition
await client.deployDefinition({
  id: 'loan-application',
  machineDefinition: {
    initial: 'submitted',
    states: {
      submitted:  { on: { APPROVE: 'approved', REJECT: 'rejected' } },
      approved:   { on: { DISBURSE: 'disbursed' } },
      rejected:   { type: 'final' },
      disbursed:  { type: 'final' },
    },
  },
});

// 2. Spawn an actor (one actor = one live application)
const actor = await client.spawnActor({
  definitionId: 'loan-application',
  initialContext: { applicantId: 'usr_123', amount: 50000 },
});

// 3. Drive it forward with events
await client.sendEvent(actor.id, { type: 'APPROVE' });

// 4. Read state at any time
const state = await client.getActor(actor.id);
console.log(state.stateValue); // 'approved'
console.log(state.done);       // false
```

## API reference

### Constructor

```typescript
new StateKeepClient({
  baseUrl:   string,   // StateKeep server URL (no trailing slash)
  apiKey:    string,   // x-api-key header value
  timeoutMs: number,   // Per-request timeout in ms (default: 30000)
})
```

### Actors

```typescript
// Spawn a new actor
spawnActor(options: SpawnActorOptions): Promise<Actor>

// Get current state (includes stateValue, context, status, done flag)
getActor(actorId: string): Promise<Actor>

// Send a state machine event
sendEvent(actorId: string, options: SendEventOptions): Promise<Actor>

// List event history (cursor-paginated)
listActorEvents(actorId: string, options?: ListActorEventsOptions): Promise<ListActorEventsResult>

// Bulk-spawn up to 500 actors in one call (returns 207 Multi-Status)
bulkSpawnActors(options: BulkSpawnOptions): Promise<BulkSpawnResult>
```

### Definitions

```typescript
// Deploy or update a state machine definition
deployDefinition(options: DeployDefinitionOptions): Promise<StateMachineDefinition>

// Fetch a definition by ID
getDefinition(definitionId: string): Promise<StateMachineDefinition>
```

### Webhooks

```typescript
listWebhooks():                                          Promise<ListWebhooksResult>
getWebhook(webhookId: string):                           Promise<Webhook>
createWebhook(options: CreateWebhookOptions):            Promise<Webhook>
updateWebhook(webhookId: string, options: UpdateWebhookOptions): Promise<Webhook>
deleteWebhook(webhookId: string):                        Promise<void>
```

### Error handling

All network or HTTP-error responses throw `StateKeepRequestError`:

```typescript
import { StateKeepClient, StateKeepRequestError } from '@statekeep/sdk';

try {
  await client.sendEvent('nonexistent-actor', { type: 'START' });
} catch (err) {
  if (err instanceof StateKeepRequestError) {
    console.error(err.statusCode, err.body.message);
  }
}
```

## Breaking-change deploys (confirmToken flow)

When a new definition version removes or renames states that live actors occupy, the API returns `requires_confirmation` instead of deploying immediately:

```typescript
const res = await client.deployDefinition({
  id: 'loan-v2',
  parentId: 'loan-v1',
  machineDefinition: { /* new version */ },
  stateMapping: { submitted: 'in_review' },   // rename state
});

if ((res as any).status === 'requires_confirmation') {
  const preview = res as any;
  console.log(`${preview.strandedActors.length} actors need migration`);

  // Re-submit with the token to confirm
  await client.deployDefinition({
    id: 'loan-v2',
    parentId: 'loan-v1',
    machineDefinition: { /* same */ },
    stateMapping: { submitted: 'in_review' },
    confirmToken: preview.confirmToken,
  } as any);
}
```

## Build

```bash
npm run build      # tsc → dist/
npm run typecheck  # type-check only
```

## Limitations

- State machine definitions must be plain JSON (XState v5 `setup()` syntax with inline TypeScript functions is not supported — see [docs/xstate-compatibility.md](../docs/xstate-compatibility.md)).
- Guards and actions in definitions are stubbed; actors always take the first matching transition. Customer backends own side effects via webhooks or by reading `stateValue` from the response.
- The SDK ships with zero runtime dependencies and requires Node.js ≥ 18 (uses global `fetch`).
