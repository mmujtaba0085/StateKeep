# Bank/Loan System Testing Environment

A standalone testing environment for a comprehensive Bank and Loan application system. This project is designed to test core banking functionality independently before integration with StateKeep.

## Project Structure

```
test-bank-system/
├── src/
│   ├── statecharts/          # State machine definitions (SCXML/JSON format)
│   │   ├── loanApplication.json   # Loan application workflow states
│   │   ├── account.json            # Account lifecycle states
│   │   └── transaction.json        # Transaction processing states
│   ├── services/             # Business logic services
│   │   ├── loanService.js         # Loan application processing
│   │   ├── accountService.js      # Account management
│   │   └── transactionService.js  # Transaction handling
│   ├── api/                  # REST API endpoints
│   │   ├── server.js              # Express server setup
│   │   └── routes.js              # API routes
│   └── tests/                # Test suite
│       ├── loanApplication.test.js
│       ├── account.test.js
│       └── transaction.test.js
├── examples/
│   └── scenarios/            # Example workflows and test scenarios
├── package.json
└── README.md
```

## Features

### 1. **Loan Application Workflow**
- Loan request submission
- Application review process
- Approval/rejection workflow
- Disbursement management

### 2. **Account Management**
- Account creation and activation
- Customer profile management
- Account status transitions
- Account closure workflow

### 3. **Transaction Processing**
- Deposits and withdrawals
- Fund transfers between accounts
- Payment processing
- Transaction settlement

## Getting Started

### Installation

```bash
# Install dependencies
npm install
```

### Running the Server

```bash
# Development mode (auto-reload)
npm run dev

# Production mode
npm start
```

The server will run on a free local port by default. Set `PORT` if you want a fixed one.

### Running Tests

```bash
# Run all tests
npm test

# Run tests in watch mode
npm run test:watch

# Run specific test suite
npm run test:loan
npm run test:account
npm run test:transaction
```

## API Endpoints

### Loan Application
- `POST /api/loans/apply` - Submit a new loan application
- `GET /api/loans/:id` - Get loan application status
- `PUT /api/loans/:id/review` - Review a loan application
- `PUT /api/loans/:id/approve` - Approve a loan

### Account Management
- `POST /api/accounts` - Create new account
- `GET /api/accounts/:id` - Get account details
- `PUT /api/accounts/:id/activate` - Activate account
- `PUT /api/accounts/:id/close` - Close account

### Transactions
- `POST /api/transactions/deposit` - Process deposit
- `POST /api/transactions/withdraw` - Process withdrawal
- `POST /api/transactions/transfer` - Transfer funds
- `GET /api/transactions/:id` - Get transaction details

## State Machines

Each major workflow is defined as a state machine:

### Loan Application States
```
idle → submitted → underreview → approved/rejected → disbursed
```

### Account States
```
pending → active → suspended → closed
```

### Transaction States
```
initiated → processing → settled/failed
```

## Example Workflows

See `/examples/scenarios/` for sample workflows demonstrating:
- Complete loan application process
- Account lifecycle
- Multi-step transaction scenarios

## Integration with StateKeep

This project is designed to work independently first. Once testing is complete:

1. Export statechart definitions to StateKeep format
2. Connect services to StateKeep actors
3. Use StateKeep for distributed state management
4. Scale to multi-instance deployments

See [INTEGRATION.md](INTEGRATION.md) (coming soon) for integration steps.

## Testing Approach

- **Unit Tests**: Service layer logic
- **Integration Tests**: API endpoint workflows
- **Scenario Tests**: Complex multi-step workflows
- **State Transition Tests**: Validate state machine behavior

## Development Workflow

1. Define statecharts for your workflows
2. Implement services to handle state transitions
3. Create API routes that trigger transitions
4. Write tests for each workflow
5. Test with example scenarios
6. Prepare for StateKeep integration

## Next Steps

- [ ] Implement statechart definitions
- [ ] Create service implementations
- [ ] Set up API routes
- [ ] Write comprehensive tests
- [ ] Create example scenarios
- [ ] Document integration with StateKeep
- [ ] Performance testing
- [ ] Error handling and edge cases

## Environment Variables

Create a `.env` file (not tracked in git):

```
PORT=4100
NODE_ENV=development
LOG_LEVEL=debug
```

## Troubleshooting

### Port Already in Use
```bash
# Change port
PORT=3001 npm run dev
```

### Module Not Found
```bash
# Reinstall dependencies
rm -rf node_modules
npm install
```

## Resources

- [StateKeep Documentation](../README.md)
- [Express.js Guide](https://expressjs.com/)
- [Jest Testing Framework](https://jestjs.io/)
