const AccountService = require('../services/accountService');

describe('Account Service - Lifecycle Tests', () => {
  beforeEach(() => {
    AccountService.clearStore();
  });

  describe('Account Creation', () => {
    test('should create a new account', () => {
      const account = AccountService.createAccount('customer-1', {
        type: 'savings',
        currency: 'USD'
      });

      expect(account).toBeDefined();
      expect(account.status).toBe('pending');
      expect(account.customerId).toBe('customer-1');
      expect(account.accountType).toBe('savings');
      expect(account.balance).toBe(0);
    });

    test('should generate unique account IDs', () => {
      const account1 = AccountService.createAccount('customer-1', { type: 'savings' });
      const account2 = AccountService.createAccount('customer-1', { type: 'checking' });

      expect(account1.id).not.toBe(account2.id);
    });
  });

  describe('Account Verification', () => {
    test('should start identity verification', () => {
      const account = AccountService.createAccount('customer-1', {});
      
      const verifying = AccountService.verifyIdentity(account.id, {
        documentId: 'passport-123',
        documentType: 'PASSPORT'
      });

      expect(verifying.status).toBe('verifying');
      expect(verifying.verificationData).toBeDefined();
    });

    test('should complete verification and activate account', () => {
      const account = AccountService.createAccount('customer-1', {});
      AccountService.verifyIdentity(account.id, { documentId: 'passport-123' });

      const active = AccountService.completeVerification(account.id);

      expect(active.status).toBe('active');
      expect(active.verificationStatus).toBe('passed');
      expect(active.verifiedAt).toBeDefined();
    });

    test('should fail verification', () => {
      const account = AccountService.createAccount('customer-1', {});
      AccountService.verifyIdentity(account.id, { documentId: 'fake-123' });

      const rejected = AccountService.failVerification(
        account.id,
        'Document verification failed'
      );

      expect(rejected.status).toBe('rejected');
      expect(rejected.verificationStatus).toBe('failed');
      expect(rejected.rejectionReason).toBe('Document verification failed');
    });
  });

  describe('Account Suspension', () => {
    test('should suspend an active account', () => {
      const account = AccountService.createAccount('customer-1', {});
      AccountService.verifyIdentity(account.id, { documentId: 'passport-123' });
      AccountService.completeVerification(account.id);

      const suspended = AccountService.suspendAccount(account.id, 'Suspicious activity');

      expect(suspended.status).toBe('suspended');
      expect(suspended.suspensionReason).toBe('Suspicious activity');
    });

    test('should reactivate a suspended account', () => {
      const account = AccountService.createAccount('customer-1', {});
      AccountService.verifyIdentity(account.id, { documentId: 'passport-123' });
      AccountService.completeVerification(account.id);
      AccountService.suspendAccount(account.id, 'Verification issue');

      const reactivated = AccountService.reactivateAccount(account.id);

      expect(reactivated.status).toBe('active');
      expect(reactivated.reactivatedAt).toBeDefined();
    });
  });

  describe('Account Closure', () => {
    test('should request account closure', () => {
      const account = AccountService.createAccount('customer-1', {});
      AccountService.verifyIdentity(account.id, { documentId: 'passport-123' });
      AccountService.completeVerification(account.id);

      const closureRequested = AccountService.requestClosure(account.id);

      expect(closureRequested.status).toBe('closureRequested');
      expect(closureRequested.closureRequestedAt).toBeDefined();
    });

    test('should close an account with zero balance', () => {
      const account = AccountService.createAccount('customer-1', {});
      AccountService.verifyIdentity(account.id, { documentId: 'passport-123' });
      AccountService.completeVerification(account.id);
      AccountService.requestClosure(account.id);

      const closed = AccountService.confirmClosure(account.id);

      expect(closed.status).toBe('closed');
      expect(closed.closedAt).toBeDefined();
    });

    test('should not close account with remaining balance', () => {
      const account = AccountService.createAccount('customer-1', {});
      AccountService.verifyIdentity(account.id, { documentId: 'passport-123' });
      AccountService.completeVerification(account.id);
      AccountService.updateBalance(account.id, 1000);
      AccountService.requestClosure(account.id);

      expect(() => {
        AccountService.confirmClosure(account.id);
      }).toThrow('Cannot close account with remaining balance');
    });

    test('should cancel closure request', () => {
      const account = AccountService.createAccount('customer-1', {});
      AccountService.verifyIdentity(account.id, { documentId: 'passport-123' });
      AccountService.completeVerification(account.id);
      AccountService.requestClosure(account.id);

      const cancelled = AccountService.cancelClosure(account.id);

      expect(cancelled.status).toBe('active');
    });
  });

  describe('Balance Management', () => {
    test('should update account balance', () => {
      const account = AccountService.createAccount('customer-1', {});
      AccountService.verifyIdentity(account.id, { documentId: 'passport-123' });
      AccountService.completeVerification(account.id);

      const updated1 = AccountService.updateBalance(account.id, 5000);
      expect(updated1.balance).toBe(5000);

      const updated2 = AccountService.updateBalance(account.id, 3000);
      expect(updated2.balance).toBe(8000);

      const updated3 = AccountService.updateBalance(account.id, -2000);
      expect(updated3.balance).toBe(6000);
    });

    test('should not update balance for non-active account', () => {
      const account = AccountService.createAccount('customer-1', {});

      expect(() => {
        AccountService.updateBalance(account.id, 5000);
      }).toThrow('Cannot update balance for account in status: pending');
    });
  });

  describe('Complete Account Lifecycle', () => {
    test('should complete full account lifecycle', () => {
      // Step 1: Create account
      const account = AccountService.createAccount('customer-1', {
        type: 'savings',
        currency: 'USD'
      });
      expect(account.status).toBe('pending');

      // Step 2: Verify identity
      const verifying = AccountService.verifyIdentity(account.id, {
        documentId: 'passport-123',
        documentType: 'PASSPORT'
      });
      expect(verifying.status).toBe('verifying');

      // Step 3: Complete verification
      const active = AccountService.completeVerification(account.id);
      expect(active.status).toBe('active');

      // Step 4: Use account
      const withBalance = AccountService.updateBalance(account.id, 10000);
      expect(withBalance.balance).toBe(10000);

      // Step 5: Request closure
      const closureRequested = AccountService.requestClosure(account.id);
      expect(closureRequested.status).toBe('closureRequested');

      // Step 6: Withdraw funds
      const withdrawn = AccountService.updateBalance(account.id, -10000);
      expect(withdrawn.balance).toBe(0);

      // Step 7: Close account
      const closed = AccountService.confirmClosure(account.id);
      expect(closed.status).toBe('closed');
    });
  });

  describe('Error Cases', () => {
    test('should throw error for non-existent account', () => {
      expect(() => {
        AccountService.getAccount('non-existent-id');
      }).toThrow('Account not found');
    });

    test('should not allow invalid state transitions', () => {
      const account = AccountService.createAccount('customer-1', {});

      expect(() => {
        AccountService.completeVerification(account.id);
      }).toThrow('Cannot complete verification for account in status: pending');
    });
  });
});
