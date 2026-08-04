# StateKeep Demo: Bank & Loan System

A working demonstration of StateKeep running real banking workflows. Three state machines — loan applications, accounts, and transactions — run as live actors managed by StateKeep, with a local Express API in front.

This is not a toy: it exercises spawning thousands of actors, sending concurrent events, and live migration when you redeploy a definition.

---

## What it shows

| Workflow | States | Key events |
|----------|--------|------------|
| Loan application | idle → submitted → underReview → approved/rejected → disbursed | SUBMIT_APPLICATION, APPROVE, REJECT, DISBURSE |
| Account | pending → active → suspended → closed | ACTIVATE, SUSPEND, CLOSE |
| Transaction | initiated → processing → settled / failed | PROCESS, SETTLE, FAIL |

---

## Prerequisites

- **StateKeep running** on `http://localhost:3001` with a valid API key
- Node.js 22+

---

## Setup

**1. Copy and fill in the env file:**

```bash
cp .env.example .env
```

Edit `.env`:
```env
STATEKEEP_URL=http://localhost:3001
STATEKEEP_API_KEY=sk_live_...     # your key from StateKeep .env
```

**2. Install dependencies:**

```bash
npm install
```

**3. Deploy the state machine definitions to StateKeep:**

```bash
node scripts/precheck-statekeep.js
```

This registers the three machine definitions (`loanApplication`, `account`, `transaction`) with your StateKeep instance. It is idempotent — safe to run again if you restart.

**4. Start the demo API:**

```bash
npm start
# or for live reload during development:
npm run dev
```

The Express server starts on `http://localhost:4100` (or `PORT` from your env).

---

## Using the demo API

All requests go through this server, which translates them into StateKeep actor operations.

### Loan application

```bash
# Start a new loan application
curl -X POST http://localhost:4100/api/loans/apply \
  -H "Content-Type: application/json" \
  -d '{"applicantId":"user-1","loanAmount":15000,"term":24}'

# Get status
curl http://localhost:4100/api/loans/:id

# Advance through the workflow
curl -X PUT http://localhost:4100/api/loans/:id/review    # START_REVIEW
curl -X PUT http://localhost:4100/api/loans/:id/approve   # APPROVE
```

### Account lifecycle

```bash
curl -X POST http://localhost:4100/api/accounts          # create
curl -X PUT  http://localhost:4100/api/accounts/:id/activate
curl -X PUT  http://localhost:4100/api/accounts/:id/close
```

### Transactions

```bash
curl -X POST http://localhost:4100/api/transactions/deposit  \
  -d '{"accountId":"...","amount":500}'
curl -X POST http://localhost:4100/api/transactions/transfer \
  -d '{"fromId":"...","toId":"...","amount":200}'
```

---

## Running tests

Unit tests run against mock services (no StateKeep needed):

```bash
npm test                    # all unit tests
npm run test:loan           # loan application tests only
npm run test:account        # account tests only
npm run test:transaction    # transaction tests only
```

Integration tests run against a live StateKeep instance (requires `.env` with a real key and StateKeep running):

```bash
npm run test:statekeep      # deploys definitions, then runs integration tests
npm run test:integration    # integration tests only (skip the precheck)
```

---

## How it connects to StateKeep

Each loan, account, or transaction is a **StateKeep actor**. When you call the Express API:

1. `POST /api/loans/apply` → spawns a new actor with definition `loanApplication`
2. `PUT /api/loans/:id/approve` → sends event `APPROVE` to that actor
3. `GET /api/loans/:id` → reads current actor state from StateKeep

The state machine logic lives entirely in StateKeep. The Express layer is just a domain-friendly HTTP wrapper.

### Live migration demo

To see APV migration in action:

1. Spawn some loan actors and advance them through various states
2. Modify `src/statecharts/loanApplication.json` (e.g. add a new `dueDiligence` state)
3. Redeploy the definition: `node scripts/precheck-statekeep.js`
4. Watch actors automatically migrate to the new version via StateKeep's migrate-worker

---

## File structure

```
test-bank-system/
├── src/
│   ├── api/
│   │   ├── server.js          Express server
│   │   └── routes.js          REST endpoints
│   ├── services/
│   │   ├── loanService.js     StateKeep calls for loans
│   │   ├── accountService.js  StateKeep calls for accounts
│   │   └── transactionService.js
│   ├── statecharts/
│   │   ├── loanApplication.json   Machine definition
│   │   ├── account.json
│   │   └── transaction.json
│   └── tests/
│       ├── loanApplication.test.js
│       ├── account.test.js
│       ├── transaction.test.js
│       ├── statekeep.integration.test.js
│       ├── statekeep.runtime.integration.test.js
│       └── statekeepHelper.js
├── scripts/
│   └── precheck-statekeep.js  Deploys definitions to StateKeep
├── .env.example
└── package.json
```
