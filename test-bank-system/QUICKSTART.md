# Bank System Testing - Quick Start Guide

## Prerequisites

- Node.js (v16 or higher)
- npm
- A terminal or command prompt

## Installation & Setup

### 1. Install Dependencies

```bash
cd test-bank-system
npm install
```

### 2. Start the Server

**Development mode with auto-reload:**
```bash
npm run dev
```

**Production mode:**
```bash
npm start
```

The server will start on a free local port by default. If you want a fixed port, set `PORT` before starting.

### 3. Test the API

Use any HTTP client (curl, Postman, Insomnia, etc.)

**Health check:**
```bash
# Replace <PORT> with the port printed by the server if you do not set PORT explicitly
curl http://localhost:<PORT>/health
```

## Quick Test Scenarios

### Scenario 1: Complete Loan Application (5 minutes)

```bash
# 1. Submit application
curl -X POST http://localhost:<PORT>/api/loans/apply \
  -H "Content-Type: application/json" \
  -d '{"applicantId":"CUST-001","amount":50000,"interestRate":6.5,"term":60}'

# Save the returned application ID
# Then use it in the following calls...

# 2. Start review
curl -X PUT http://localhost:<PORT>/api/loans/{APP_ID}/review \
  -H "Content-Type: application/json" \
  -d '{"reviewerId":"OFFICER-001"}'

# 3. Request info
curl -X PUT http://localhost:<PORT>/api/loans/{APP_ID}/request-info \
  -H "Content-Type: application/json" \
  -d '{"documents":["Tax Returns","Bank Statements"]}'

# 4. Provide info
curl -X PUT http://localhost:<PORT>/api/loans/{APP_ID}/provide-info \
  -H "Content-Type: application/json" \
  -d '{"documents":["tax-2023.pdf","statement.pdf"]}'

# 5. Approve
curl -X PUT http://localhost:<PORT>/api/loans/{APP_ID}/approve \
  -H "Content-Type: application/json" \
  -d '{"approverId":"APPROVER-001"}'

# 6. Check status
curl http://localhost:<PORT>/api/loans/{APP_ID}
```

### Scenario 2: Create and Activate Account (3 minutes)

```bash
# 1. Create account
curl -X POST http://localhost:<PORT>/api/accounts \
  -H "Content-Type: application/json" \
  -d '{"customerId":"CUST-002","type":"savings","currency":"USD"}'

# Save returned account ID
# Then...

# 2. Verify identity
curl -X PUT http://localhost:<PORT>/api/accounts/{ACC_ID}/verify \
  -H "Content-Type: application/json" \
  -d '{"documentId":"PASSPORT-123","documentType":"PASSPORT"}'

# 3. Activate account
curl -X PUT http://localhost:<PORT>/api/accounts/{ACC_ID}/activate \
  -H "Content-Type: application/json"

# 4. Check status
curl http://localhost:<PORT>/api/accounts/{ACC_ID}
```

### Scenario 3: Process Transaction (2 minutes)

```bash
# 1. Initiate deposit
curl -X POST http://localhost:<PORT>/api/transactions \
  -H "Content-Type: application/json" \
  -d '{
    "sourceAccount":"EXTERNAL",
    "destinationAccount":"ACC-123",
    "amount":5000,
    "type":"deposit"
  }'

# Save transaction ID
# Then...

# 2. Validate
curl -X PUT http://localhost:<PORT>/api/transactions/{TX_ID}/validate \
  -H "Content-Type: application/json"

# 3. Authorize
curl -X PUT http://localhost:<PORT>/api/transactions/{TX_ID}/authorize \
  -H "Content-Type: application/json"

# 4. Process
curl -X PUT http://localhost:<PORT>/api/transactions/{TX_ID}/process \
  -H "Content-Type: application/json"

# 5. Settle
curl -X PUT http://localhost:<PORT>/api/transactions/{TX_ID}/settle \
  -H "Content-Type: application/json"

# 6. Check status
curl http://localhost:<PORT>/api/transactions/{TX_ID}
```

## Running Tests

```bash
# Run all tests
npm test

# Run specific test suites
npm run test:loan
npm run test:account
npm run test:transaction

# Watch mode (re-run on file changes)
npm run test:watch
```

## File Structure Reference

```
test-bank-system/
├── src/
│   ├── statecharts/         # State machine definitions
│   │   ├── loanApplication.json
│   │   ├── account.json
│   │   └── transaction.json
│   ├── services/            # Business logic
│   │   ├── loanService.js
│   │   ├── accountService.js
│   │   └── transactionService.js
│   ├── api/
│   │   ├── server.js        # Express app
│   │   └── routes.js        # API endpoints
│   └── tests/               # Jest test suites
│       ├── loanApplication.test.js
│       ├── account.test.js
│       └── transaction.test.js
├── examples/
│   └── scenarios/           # Test scenario examples
└── package.json
```

## Common Patterns

### Pattern 1: Loan Application Workflow
1. Submit → Review → Request Info → Provide Info → Approve → Disburse

### Pattern 2: Account Lifecycle
1. Create → Verify → Activate → Use → Request Close → Close

### Pattern 3: Transaction Processing
1. Initiate → Validate → Authorize → Process → Settle/Fail

## Debugging Tips

1. **Check server logs**: Watch terminal output for request logs
2. **HTTP Status Codes**:
   - `201`: Created successfully
   - `200`: Success
   - `400`: Bad request (check your JSON body)
   - `404`: Not found (wrong ID or endpoint)
   - `500`: Server error

3. **Common Issues**:
   - Wrong account/application IDs: Copy-paste the exact ID from previous response
   - JSON formatting: Use valid JSON, watch for extra commas
   - State transitions: Can't skip states (e.g., can't approve before review starts)

## Integration with StateKeep

Once you're satisfied with the workflows:

1. Export statechart definitions to StateKeep format
2. Connect services to StateKeep actors
3. Use StateKeep for distributed state management
4. Deploy to production

See `README.md` for integration details.

## Support

For detailed API documentation: See `API.md` in the parent directory
For statechart definitions: Check `src/statecharts/`
For example scenarios: Check `examples/scenarios/`
