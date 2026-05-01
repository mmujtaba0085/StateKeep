# StateKeep Examples

Real-world machine definitions and scenario files you can use immediately.

## Files

| File | Description |
|------|-------------|
| `order.definition.json` | E-commerce order lifecycle |
| `order.scenarios.json` | Scenario test suite for the order machine |
| `onboarding.definition.json` | User onboarding / KYC flow |
| `onboarding.scenarios.json` | Scenario test suite for onboarding |

## Quickstart workflow

```bash
export STATEKEEP_API_KEY=sk_...your_key...
export STATEKEEP_URL=https://your-domain.com   # or http://127.0.0.1:3001 locally

# 1. Validate a machine before deploying
./scripts/sk.sh validate examples/order.definition.json

# 2. Run scenario tests (dry run — nothing persisted)
./scripts/sk.sh scenario examples/order.scenarios.json

# 3. Deploy
./scripts/sk.sh deploy examples/order.definition.json

# 4. Spawn an actor
./scripts/sk.sh spawn order-v1

# 5. Send events
./scripts/sk.sh event <actorId> PAY
./scripts/sk.sh event <actorId> SHIP
./scripts/sk.sh event <actorId> DELIVER

# 6. Check state and full history
./scripts/sk.sh state   <actorId>
./scripts/sk.sh history <actorId>
```

## Deploy v2 with migration

```bash
# Create order-v2 definition file with "id": "order-v2"
./scripts/sk.sh deploy examples/order-v2.definition.json order-v1 2

# Check what changed between v1 and v2
./scripts/sk.sh diff order-v2
```

## From Stately Studio

1. Design your machine at https://stately.ai/studio
2. Export → "XState v5 JSON"
3. Wrap it: `{ "id": "my-machine-v1", "definition": <paste exported JSON here> }`
4. Save as `my-machine.definition.json`
5. Run `./scripts/sk.sh validate my-machine.definition.json`
6. Run `./scripts/sk.sh deploy my-machine.definition.json`
