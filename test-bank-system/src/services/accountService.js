const { v4: uuidv4 } = require('uuid');

/**
 * In-memory store for accounts (replace with database later)
 */
const accountStore = new Map();

/**
 * Account Service - Handles account lifecycle
 */
class AccountService {
  /**
   * Create a new account
   */
  static createAccount(customerId, accountData) {
    const accountId = uuidv4();
    
    const account = {
      id: accountId,
      customerId,
      status: 'pending',
      accountType: accountData.type || 'savings',
      currency: accountData.currency || 'USD',
      balance: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      verificationStatus: null
    };

    accountStore.set(accountId, account);
    console.log(`[AccountService] New account created: ${accountId}`);
    
    return account;
  }

  /**
   * Get account by ID
   */
  static getAccount(accountId) {
    const account = accountStore.get(accountId);
    if (!account) {
      throw new Error(`Account not found: ${accountId}`);
    }
    return account;
  }

  /**
   * Verify account identity
   */
  static verifyIdentity(accountId, verificationData) {
    const account = this.getAccount(accountId);
    
    if (account.status !== 'pending') {
      throw new Error(`Cannot verify account in status: ${account.status}`);
    }

    account.status = 'verifying';
    account.verificationData = verificationData;
    account.verificationStartedAt = new Date().toISOString();
    account.updatedAt = new Date().toISOString();
    
    console.log(`[AccountService] Identity verification started: ${accountId}`);
    return account;
  }

  /**
   * Complete verification successfully
   */
  static completeVerification(accountId) {
    const account = this.getAccount(accountId);
    
    if (account.status !== 'verifying') {
      throw new Error(`Cannot complete verification for account in status: ${account.status}`);
    }

    account.status = 'active';
    account.verificationStatus = 'passed';
    account.verifiedAt = new Date().toISOString();
    account.updatedAt = new Date().toISOString();
    
    console.log(`[AccountService] Account verified and activated: ${accountId}`);
    return account;
  }

  /**
   * Fail verification
   */
  static failVerification(accountId, reason) {
    const account = this.getAccount(accountId);
    
    if (account.status !== 'verifying') {
      throw new Error(`Cannot fail verification for account in status: ${account.status}`);
    }

    account.status = 'rejected';
    account.verificationStatus = 'failed';
    account.rejectionReason = reason;
    account.updatedAt = new Date().toISOString();
    
    console.log(`[AccountService] Account verification failed: ${accountId}`);
    return account;
  }

  /**
   * Suspend an account
   */
  static suspendAccount(accountId, reason) {
    const account = this.getAccount(accountId);
    
    if (account.status !== 'active') {
      throw new Error(`Cannot suspend account in status: ${account.status}`);
    }

    account.status = 'suspended';
    account.suspensionReason = reason;
    account.suspendedAt = new Date().toISOString();
    account.updatedAt = new Date().toISOString();
    
    console.log(`[AccountService] Account suspended: ${accountId}`);
    return account;
  }

  /**
   * Reactivate a suspended account
   */
  static reactivateAccount(accountId) {
    const account = this.getAccount(accountId);
    
    if (account.status !== 'suspended') {
      throw new Error(`Cannot reactivate account in status: ${account.status}`);
    }

    account.status = 'active';
    account.reactivatedAt = new Date().toISOString();
    account.updatedAt = new Date().toISOString();
    
    console.log(`[AccountService] Account reactivated: ${accountId}`);
    return account;
  }

  /**
   * Request account closure
   */
  static requestClosure(accountId) {
    const account = this.getAccount(accountId);
    
    if (!['active', 'suspended'].includes(account.status)) {
      throw new Error(`Cannot request closure for account in status: ${account.status}`);
    }

    account.status = 'closureRequested';
    account.closureRequestedAt = new Date().toISOString();
    account.updatedAt = new Date().toISOString();
    
    console.log(`[AccountService] Closure requested for account: ${accountId}`);
    return account;
  }

  /**
   * Confirm closure and close account
   */
  static confirmClosure(accountId) {
    const account = this.getAccount(accountId);
    
    if (account.status !== 'closureRequested') {
      throw new Error(`Cannot confirm closure for account in status: ${account.status}`);
    }

    if (account.balance > 0) {
      throw new Error(`Cannot close account with remaining balance: ${account.balance}`);
    }

    account.status = 'closed';
    account.closedAt = new Date().toISOString();
    account.updatedAt = new Date().toISOString();
    
    console.log(`[AccountService] Account closed: ${accountId}`);
    return account;
  }

  /**
   * Cancel closure request
   */
  static cancelClosure(accountId) {
    const account = this.getAccount(accountId);
    
    if (account.status !== 'closureRequested') {
      throw new Error(`Cannot cancel closure for account in status: ${account.status}`);
    }

    account.status = 'active';
    account.closureCancelledAt = new Date().toISOString();
    account.updatedAt = new Date().toISOString();
    
    console.log(`[AccountService] Closure cancelled for account: ${accountId}`);
    return account;
  }

  /**
   * Update account balance
   */
  static updateBalance(accountId, amount) {
    const account = this.getAccount(accountId);
    
    if (!['active', 'closureRequested'].includes(account.status)) {
      throw new Error(`Cannot update balance for account in status: ${account.status}`);
    }

    account.balance += amount;
    account.updatedAt = new Date().toISOString();
    
    return account;
  }

  /**
   * Get all accounts for a customer
   */
  static getAccountsByCustomer(customerId) {
    return Array.from(accountStore.values()).filter(
      account => account.customerId === customerId
    );
  }

  /**
   * Clear store (for testing)
   */
  static clearStore() {
    accountStore.clear();
  }
}

module.exports = AccountService;
