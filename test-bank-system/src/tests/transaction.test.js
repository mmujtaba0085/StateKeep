const TransactionService = require('../services/transactionService');

describe('Transaction Service - Processing Tests', () => {
  beforeEach(() => {
    TransactionService.clearStore();
  });

  describe('Transaction Initiation', () => {
    test('should initiate a deposit transaction', () => {
      const transaction = TransactionService.initiateTransaction({
        sourceAccount: 'external',
        destinationAccount: 'account-123',
        amount: 5000,
        type: 'deposit',
        description: 'Initial deposit'
      });

      expect(transaction).toBeDefined();
      expect(transaction.status).toBe('initiated');
      expect(transaction.amount).toBe(5000);
      expect(transaction.type).toBe('deposit');
    });

    test('should initiate a withdrawal transaction', () => {
      const transaction = TransactionService.initiateTransaction({
        sourceAccount: 'account-123',
        destinationAccount: 'external',
        amount: 2000,
        type: 'withdrawal'
      });

      expect(transaction.status).toBe('initiated');
      expect(transaction.type).toBe('withdrawal');
    });

    test('should initiate a transfer transaction', () => {
      const transaction = TransactionService.initiateTransaction({
        sourceAccount: 'account-123',
        destinationAccount: 'account-456',
        amount: 1500,
        type: 'transfer'
      });

      expect(transaction.status).toBe('initiated');
      expect(transaction.type).toBe('transfer');
      expect(transaction.sourceAccount).toBe('account-123');
      expect(transaction.destinationAccount).toBe('account-456');
    });
  });

  describe('Transaction Validation', () => {
    test('should validate a transaction', () => {
      const transaction = TransactionService.initiateTransaction({
        sourceAccount: 'account-123',
        destinationAccount: 'account-456',
        amount: 1000,
        type: 'transfer'
      });

      const validated = TransactionService.validateTransaction(transaction.id);

      expect(validated.status).toBe('validating');
      expect(validated.validatedAt).toBeDefined();
    });

    test('should fail validation for invalid amount', () => {
      const transaction = TransactionService.initiateTransaction({
        sourceAccount: 'account-123',
        destinationAccount: 'account-456',
        amount: -500,
        type: 'transfer'
      });

      const failed = TransactionService.validateTransaction(transaction.id);

      expect(failed.status).toBe('failed');
      expect(failed.errorMessage).toBe('Invalid amount');
    });

    test('should fail validation for zero amount', () => {
      const transaction = TransactionService.initiateTransaction({
        sourceAccount: 'account-123',
        destinationAccount: 'account-456',
        amount: 0,
        type: 'transfer'
      });

      const failed = TransactionService.validateTransaction(transaction.id);

      expect(failed.status).toBe('failed');
    });
  });

  describe('Transaction Authorization', () => {
    test('should authorize a validated transaction', () => {
      const transaction = TransactionService.initiateTransaction({
        sourceAccount: 'account-123',
        destinationAccount: 'account-456',
        amount: 1000,
        type: 'transfer'
      });
      TransactionService.validateTransaction(transaction.id);

      const authorized = TransactionService.authorizeTransaction(transaction.id);

      expect(authorized.status).toBe('authorized');
      expect(authorized.authorizedAt).toBeDefined();
    });

    test('should not authorize non-validated transaction', () => {
      const transaction = TransactionService.initiateTransaction({
        sourceAccount: 'account-123',
        amount: 1000,
        type: 'deposit'
      });

      expect(() => {
        TransactionService.authorizeTransaction(transaction.id);
      }).toThrow();
    });
  });

  describe('Transaction Processing', () => {
    test('should process an authorized transaction', () => {
      const transaction = TransactionService.initiateTransaction({
        sourceAccount: 'account-123',
        destinationAccount: 'account-456',
        amount: 1000,
        type: 'transfer'
      });
      TransactionService.validateTransaction(transaction.id);
      TransactionService.authorizeTransaction(transaction.id);

      const processing = TransactionService.processTransaction(transaction.id);

      expect(processing.status).toBe('processing');
      expect(processing.processingStartedAt).toBeDefined();
    });

    test('should settle a processed transaction', () => {
      const transaction = TransactionService.initiateTransaction({
        sourceAccount: 'account-123',
        destinationAccount: 'account-456',
        amount: 1000,
        type: 'transfer'
      });
      TransactionService.validateTransaction(transaction.id);
      TransactionService.authorizeTransaction(transaction.id);
      TransactionService.processTransaction(transaction.id);

      const settled = TransactionService.settleTransaction(transaction.id);

      expect(settled.status).toBe('settled');
      expect(settled.settledAt).toBeDefined();
    });

    test('should handle transaction failure', () => {
      const transaction = TransactionService.initiateTransaction({
        sourceAccount: 'account-123',
        destinationAccount: 'account-456',
        amount: 1000,
        type: 'transfer'
      });
      TransactionService.validateTransaction(transaction.id);
      TransactionService.authorizeTransaction(transaction.id);
      TransactionService.processTransaction(transaction.id);

      const failed = TransactionService.failTransaction(
        transaction.id,
        'Insufficient funds'
      );

      expect(failed.status).toBe('failed');
      expect(failed.errorMessage).toBe('Insufficient funds');
    });
  });

  describe('Transaction Retry', () => {
    test('should set transaction to pending', () => {
      const transaction = TransactionService.initiateTransaction({
        sourceAccount: 'account-123',
        destinationAccount: 'account-456',
        amount: 1000,
        type: 'transfer'
      });
      TransactionService.validateTransaction(transaction.id);
      TransactionService.authorizeTransaction(transaction.id);
      TransactionService.processTransaction(transaction.id);

      const pending = TransactionService.setPending(
        transaction.id,
        'Network timeout'
      );

      expect(pending.status).toBe('pending');
      expect(pending.pendingReason).toBe('Network timeout');
      expect(pending.retryCount).toBe(1);
    });

    test('should retry a pending transaction', () => {
      const transaction = TransactionService.initiateTransaction({
        sourceAccount: 'account-123',
        destinationAccount: 'account-456',
        amount: 1000,
        type: 'transfer'
      });
      TransactionService.validateTransaction(transaction.id);
      TransactionService.authorizeTransaction(transaction.id);
      TransactionService.processTransaction(transaction.id);
      TransactionService.setPending(transaction.id, 'Timeout');

      const retried = TransactionService.retryTransaction(transaction.id);

      expect(retried.status).toBe('processing');
    });

    test('should track retry count', () => {
      const transaction = TransactionService.initiateTransaction({
        sourceAccount: 'account-123',
        destinationAccount: 'account-456',
        amount: 1000,
        type: 'transfer'
      });
      TransactionService.validateTransaction(transaction.id);
      TransactionService.authorizeTransaction(transaction.id);
      TransactionService.processTransaction(transaction.id);

      let pending1 = TransactionService.setPending(transaction.id, 'Timeout 1');
      expect(pending1.retryCount).toBe(1);

      TransactionService.retryTransaction(transaction.id);
      TransactionService.processTransaction(transaction.id);
      let pending2 = TransactionService.setPending(transaction.id, 'Timeout 2');
      expect(pending2.retryCount).toBe(2);
    });
  });

  describe('Complete Transaction Workflow', () => {
    test('should complete full transaction from initiation to settlement', () => {
      // Step 1: Initiate
      const transaction = TransactionService.initiateTransaction({
        sourceAccount: 'account-123',
        destinationAccount: 'account-456',
        amount: 5000,
        type: 'transfer',
        description: 'Payment'
      });
      expect(transaction.status).toBe('initiated');

      // Step 2: Validate
      const validated = TransactionService.validateTransaction(transaction.id);
      expect(validated.status).toBe('validating');

      // Step 3: Authorize
      const authorized = TransactionService.authorizeTransaction(transaction.id);
      expect(authorized.status).toBe('authorized');

      // Step 4: Process
      const processing = TransactionService.processTransaction(transaction.id);
      expect(processing.status).toBe('processing');

      // Step 5: Settle
      const settled = TransactionService.settleTransaction(transaction.id);
      expect(settled.status).toBe('settled');
    });

    test('should handle transaction with retry', () => {
      // Initiation through authorization
      const transaction = TransactionService.initiateTransaction({
        sourceAccount: 'account-123',
        destinationAccount: 'account-456',
        amount: 5000,
        type: 'transfer'
      });
      TransactionService.validateTransaction(transaction.id);
      TransactionService.authorizeTransaction(transaction.id);

      // First processing attempt
      TransactionService.processTransaction(transaction.id);

      // Encounter timeout
      const pending = TransactionService.setPending(transaction.id, 'Network timeout');
      expect(pending.status).toBe('pending');
      expect(pending.retryCount).toBe(1);

      // Retry
      TransactionService.retryTransaction(transaction.id);
      TransactionService.processTransaction(transaction.id);

      // Successful settlement
      const settled = TransactionService.settleTransaction(transaction.id);
      expect(settled.status).toBe('settled');
    });
  });

  describe('Transaction Queries', () => {
    test('should get all transactions for an account', () => {
      TransactionService.initiateTransaction({
        sourceAccount: 'account-123',
        destinationAccount: 'account-456',
        amount: 1000,
        type: 'transfer'
      });
      TransactionService.initiateTransaction({
        sourceAccount: 'account-123',
        destinationAccount: 'external',
        amount: 500,
        type: 'withdrawal'
      });
      TransactionService.initiateTransaction({
        sourceAccount: 'account-789',
        destinationAccount: 'account-123',
        amount: 2000,
        type: 'transfer'
      });

      const transactions = TransactionService.getTransactionsByAccount('account-123');

      expect(transactions).toHaveLength(3);
    });

    test('should get transactions by status', () => {
      const tx1 = TransactionService.initiateTransaction({
        sourceAccount: 'account-123',
        amount: 1000,
        type: 'deposit'
      });
      TransactionService.validateTransaction(tx1.id);

      const tx2 = TransactionService.initiateTransaction({
        sourceAccount: 'account-456',
        amount: 2000,
        type: 'deposit'
      });

      const validating = TransactionService.getTransactionsByStatus('validating');
      expect(validating).toHaveLength(1);

      const initiated = TransactionService.getTransactionsByStatus('initiated');
      expect(initiated).toHaveLength(1);
    });
  });

  describe('Error Cases', () => {
    test('should throw error for non-existent transaction', () => {
      expect(() => {
        TransactionService.getTransaction('non-existent-id');
      }).toThrow('Transaction not found');
    });

    test('should not allow invalid state transitions', () => {
      const transaction = TransactionService.initiateTransaction({
        sourceAccount: 'account-123',
        amount: 1000,
        type: 'deposit'
      });

      expect(() => {
        TransactionService.processTransaction(transaction.id);
      }).toThrow();
    });
  });
});
