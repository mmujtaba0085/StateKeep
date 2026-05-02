const { v4: uuidv4 } = require('uuid');

/**
 * In-memory store for transactions (replace with database later)
 */
const transactionStore = new Map();

/**
 * Transaction Service - Handles financial transactions
 */
class TransactionService {
  /**
   * Initiate a transaction
   */
  static initiateTransaction(transactionData) {
    const transactionId = uuidv4();
    
    const transaction = {
      id: transactionId,
      sourceAccount: transactionData.sourceAccount,
      destinationAccount: transactionData.destinationAccount || null,
      amount: transactionData.amount,
      currency: transactionData.currency || 'USD',
      type: transactionData.type, // 'deposit', 'withdrawal', 'transfer'
      status: 'initiated',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      reference: transactionData.reference || null,
      description: transactionData.description || ''
    };

    transactionStore.set(transactionId, transaction);
    console.log(`[TransactionService] Transaction initiated: ${transactionId}`);
    
    return transaction;
  }

  /**
   * Get transaction by ID
   */
  static getTransaction(transactionId) {
    const transaction = transactionStore.get(transactionId);
    if (!transaction) {
      throw new Error(`Transaction not found: ${transactionId}`);
    }
    return transaction;
  }

  /**
   * Validate a transaction
   */
  static validateTransaction(transactionId) {
    const transaction = this.getTransaction(transactionId);
    
    if (transaction.status !== 'initiated') {
      throw new Error(`Cannot validate transaction in status: ${transaction.status}`);
    }

    // Perform validation checks
    if (!transaction.amount || transaction.amount <= 0) {
      transaction.status = 'failed';
      transaction.errorMessage = 'Invalid amount';
      transaction.updatedAt = new Date().toISOString();
      return transaction;
    }

    transaction.status = 'validating';
    transaction.validatedAt = new Date().toISOString();
    transaction.updatedAt = new Date().toISOString();
    
    console.log(`[TransactionService] Transaction validated: ${transactionId}`);
    return transaction;
  }

  /**
   * Complete validation and authorize
   */
  static authorizeTransaction(transactionId) {
    const transaction = this.getTransaction(transactionId);
    
    if (transaction.status !== 'validating') {
      throw new Error(`Cannot authorize transaction in status: ${transaction.status}`);
    }

    transaction.status = 'authorized';
    transaction.authorizedAt = new Date().toISOString();
    transaction.updatedAt = new Date().toISOString();
    
    console.log(`[TransactionService] Transaction authorized: ${transactionId}`);
    return transaction;
  }

  /**
   * Process a transaction
   */
  static processTransaction(transactionId) {
    const transaction = this.getTransaction(transactionId);
    
    if (!['authorized', 'processing'].includes(transaction.status)) {
      throw new Error(`Cannot process transaction in status: ${transaction.status}`);
    }

    if (transaction.status === 'processing') {
      return transaction;
    }

    transaction.status = 'processing';
    transaction.processingStartedAt = new Date().toISOString();
    transaction.updatedAt = new Date().toISOString();
    
    console.log(`[TransactionService] Transaction processing: ${transactionId}`);
    return transaction;
  }

  /**
   * Successfully settle a transaction
   */
  static settleTransaction(transactionId) {
    const transaction = this.getTransaction(transactionId);
    
    if (transaction.status !== 'processing') {
      throw new Error(`Cannot settle transaction in status: ${transaction.status}`);
    }

    transaction.status = 'settled';
    transaction.settledAt = new Date().toISOString();
    transaction.updledAt = new Date().toISOString();
    
    console.log(`[TransactionService] Transaction settled: ${transactionId}`);
    return transaction;
  }

  /**
   * Fail a transaction
   */
  static failTransaction(transactionId, errorMessage) {
    const transaction = this.getTransaction(transactionId);
    
    if (['settled', 'failed'].includes(transaction.status)) {
      throw new Error(`Cannot fail transaction in status: ${transaction.status}`);
    }

    transaction.status = 'failed';
    transaction.errorMessage = errorMessage;
    transaction.failedAt = new Date().toISOString();
    transaction.updatedAt = new Date().toISOString();
    
    console.log(`[TransactionService] Transaction failed: ${transactionId} - ${errorMessage}`);
    return transaction;
  }

  /**
   * Set transaction to pending (awaiting retry)
   */
  static setPending(transactionId, reason) {
    const transaction = this.getTransaction(transactionId);
    
    if (transaction.status !== 'processing') {
      throw new Error(`Cannot set to pending for transaction in status: ${transaction.status}`);
    }

    transaction.status = 'pending';
    transaction.pendingReason = reason;
    transaction.pendingSince = new Date().toISOString();
    transaction.retryCount = (transaction.retryCount || 0) + 1;
    transaction.updatedAt = new Date().toISOString();
    
    console.log(`[TransactionService] Transaction set to pending: ${transactionId}`);
    return transaction;
  }

  /**
   * Retry a pending transaction
   */
  static retryTransaction(transactionId) {
    const transaction = this.getTransaction(transactionId);
    
    if (transaction.status !== 'pending') {
      throw new Error(`Cannot retry transaction in status: ${transaction.status}`);
    }

    transaction.status = 'processing';
    transaction.updatedAt = new Date().toISOString();
    
    console.log(`[TransactionService] Transaction retry: ${transactionId}`);
    return transaction;
  }

  /**
   * Get transactions for an account
   */
  static getTransactionsByAccount(accountId) {
    return Array.from(transactionStore.values()).filter(
      tx => tx.sourceAccount === accountId || tx.destinationAccount === accountId
    );
  }

  /**
   * Get all transactions in a specific status
   */
  static getTransactionsByStatus(status) {
    return Array.from(transactionStore.values()).filter(
      tx => tx.status === status
    );
  }

  /**
   * Clear store (for testing)
   */
  static clearStore() {
    transactionStore.clear();
  }
}

module.exports = TransactionService;
