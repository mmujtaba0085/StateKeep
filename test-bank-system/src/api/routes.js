const express = require('express');
const LoanService = require('../services/loanService');
const AccountService = require('../services/accountService');
const TransactionService = require('../services/transactionService');

const router = express.Router();

// ==================== LOAN ENDPOINTS ====================

/**
 * POST /api/loans/apply
 * Submit a new loan application
 */
router.post('/loans/apply', (req, res) => {
  try {
    const { applicantId, amount, interestRate, term } = req.body;
    
    if (!applicantId || !amount) {
      return res.status(400).json({ error: 'applicantId and amount are required' });
    }

    const application = LoanService.submitApplication(applicantId, {
      amount,
      interestRate,
      term
    });

    res.status(201).json(application);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/loans/:id
 * Get loan application details
 */
router.get('/loans/:id', (req, res) => {
  try {
    const application = LoanService.getApplication(req.params.id);
    res.json(application);
  } catch (error) {
    res.status(404).json({ error: error.message });
  }
});

/**
 * PUT /api/loans/:id/review
 * Start review of loan application
 */
router.put('/loans/:id/review', (req, res) => {
  try {
    const { reviewerId } = req.body;
    if (!reviewerId) {
      return res.status(400).json({ error: 'reviewerId is required' });
    }

    const application = LoanService.startReview(req.params.id, reviewerId);
    res.json(application);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

/**
 * PUT /api/loans/:id/request-info
 * Request additional information
 */
router.put('/loans/:id/request-info', (req, res) => {
  try {
    const { documents } = req.body;
    if (!documents) {
      return res.status(400).json({ error: 'documents list is required' });
    }

    const application = LoanService.requestMoreInfo(req.params.id, documents);
    res.json(application);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

/**
 * PUT /api/loans/:id/provide-info
 * Provide requested information
 */
router.put('/loans/:id/provide-info', (req, res) => {
  try {
    const { documents } = req.body;
    if (!documents || !Array.isArray(documents)) {
      return res.status(400).json({ error: 'documents array is required' });
    }

    const application = LoanService.provideInformation(req.params.id, documents);
    res.json(application);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

/**
 * PUT /api/loans/:id/approve
 * Approve a loan application
 */
router.put('/loans/:id/approve', (req, res) => {
  try {
    const { approverId } = req.body;
    if (!approverId) {
      return res.status(400).json({ error: 'approverId is required' });
    }

    const application = LoanService.approveApplication(req.params.id, approverId);
    res.json(application);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

/**
 * PUT /api/loans/:id/reject
 * Reject a loan application
 */
router.put('/loans/:id/reject', (req, res) => {
  try {
    const { reason } = req.body;
    if (!reason) {
      return res.status(400).json({ error: 'reason is required' });
    }

    const application = LoanService.rejectApplication(req.params.id, reason);
    res.json(application);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

/**
 * PUT /api/loans/:id/disburse
 * Disburse approved loan
 */
router.put('/loans/:id/disburse', (req, res) => {
  try {
    const { accountId } = req.body;
    if (!accountId) {
      return res.status(400).json({ error: 'accountId is required' });
    }

    const application = LoanService.disburseLoans(req.params.id, accountId);
    res.json(application);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

/**
 * GET /api/loans/applicant/:applicantId
 * Get all loans for an applicant
 */
router.get('/loans/applicant/:applicantId', (req, res) => {
  try {
    const applications = LoanService.getApplicationsByApplicant(req.params.applicantId);
    res.json({ applications, count: applications.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== ACCOUNT ENDPOINTS ====================

/**
 * POST /api/accounts
 * Create a new account
 */
router.post('/accounts', (req, res) => {
  try {
    const { customerId, type, currency } = req.body;
    
    if (!customerId) {
      return res.status(400).json({ error: 'customerId is required' });
    }

    const account = AccountService.createAccount(customerId, { type, currency });
    res.status(201).json(account);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/accounts/:id
 * Get account details
 */
router.get('/accounts/:id', (req, res) => {
  try {
    const account = AccountService.getAccount(req.params.id);
    res.json(account);
  } catch (error) {
    res.status(404).json({ error: error.message });
  }
});

/**
 * PUT /api/accounts/:id/verify
 * Verify account identity
 */
router.put('/accounts/:id/verify', (req, res) => {
  try {
    const { documentId, documentType } = req.body;
    
    const account = AccountService.verifyIdentity(req.params.id, {
      documentId,
      documentType
    });
    res.json(account);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

/**
 * PUT /api/accounts/:id/activate
 * Complete verification and activate account
 */
router.put('/accounts/:id/activate', (req, res) => {
  try {
    const account = AccountService.completeVerification(req.params.id);
    res.json(account);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

/**
 * PUT /api/accounts/:id/suspend
 * Suspend an account
 */
router.put('/accounts/:id/suspend', (req, res) => {
  try {
    const { reason } = req.body;
    if (!reason) {
      return res.status(400).json({ error: 'reason is required' });
    }

    const account = AccountService.suspendAccount(req.params.id, reason);
    res.json(account);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

/**
 * PUT /api/accounts/:id/reactivate
 * Reactivate a suspended account
 */
router.put('/accounts/:id/reactivate', (req, res) => {
  try {
    const account = AccountService.reactivateAccount(req.params.id);
    res.json(account);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

/**
 * PUT /api/accounts/:id/request-close
 * Request account closure
 */
router.put('/accounts/:id/request-close', (req, res) => {
  try {
    const account = AccountService.requestClosure(req.params.id);
    res.json(account);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

/**
 * PUT /api/accounts/:id/confirm-close
 * Confirm and close account
 */
router.put('/accounts/:id/confirm-close', (req, res) => {
  try {
    const account = AccountService.confirmClosure(req.params.id);
    res.json(account);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

/**
 * GET /api/accounts/customer/:customerId
 * Get all accounts for a customer
 */
router.get('/accounts/customer/:customerId', (req, res) => {
  try {
    const accounts = AccountService.getAccountsByCustomer(req.params.customerId);
    res.json({ accounts, count: accounts.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== TRANSACTION ENDPOINTS ====================

/**
 * POST /api/transactions
 * Initiate a new transaction
 */
router.post('/transactions', (req, res) => {
  try {
    const { sourceAccount, destinationAccount, amount, type, description } = req.body;
    
    if (!sourceAccount || !amount || !type) {
      return res.status(400).json({ error: 'sourceAccount, amount, and type are required' });
    }

    const transaction = TransactionService.initiateTransaction({
      sourceAccount,
      destinationAccount,
      amount,
      type,
      description
    });

    res.status(201).json(transaction);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/transactions/:id
 * Get transaction details
 */
router.get('/transactions/:id', (req, res) => {
  try {
    const transaction = TransactionService.getTransaction(req.params.id);
    res.json(transaction);
  } catch (error) {
    res.status(404).json({ error: error.message });
  }
});

/**
 * PUT /api/transactions/:id/validate
 * Validate a transaction
 */
router.put('/transactions/:id/validate', (req, res) => {
  try {
    const transaction = TransactionService.validateTransaction(req.params.id);
    res.json(transaction);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

/**
 * PUT /api/transactions/:id/authorize
 * Authorize a transaction
 */
router.put('/transactions/:id/authorize', (req, res) => {
  try {
    const transaction = TransactionService.authorizeTransaction(req.params.id);
    res.json(transaction);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

/**
 * PUT /api/transactions/:id/process
 * Start processing a transaction
 */
router.put('/transactions/:id/process', (req, res) => {
  try {
    const transaction = TransactionService.processTransaction(req.params.id);
    res.json(transaction);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

/**
 * PUT /api/transactions/:id/settle
 * Successfully settle a transaction
 */
router.put('/transactions/:id/settle', (req, res) => {
  try {
    const transaction = TransactionService.settleTransaction(req.params.id);
    res.json(transaction);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

/**
 * PUT /api/transactions/:id/fail
 * Mark transaction as failed
 */
router.put('/transactions/:id/fail', (req, res) => {
  try {
    const { errorMessage } = req.body;
    if (!errorMessage) {
      return res.status(400).json({ error: 'errorMessage is required' });
    }

    const transaction = TransactionService.failTransaction(req.params.id, errorMessage);
    res.json(transaction);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

/**
 * GET /api/transactions/account/:accountId
 * Get transactions for an account
 */
router.get('/transactions/account/:accountId', (req, res) => {
  try {
    const transactions = TransactionService.getTransactionsByAccount(req.params.accountId);
    res.json({ transactions, count: transactions.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/transactions/status/:status
 * Get all transactions by status
 */
router.get('/transactions/status/:status', (req, res) => {
  try {
    const transactions = TransactionService.getTransactionsByStatus(req.params.status);
    res.json({ transactions, count: transactions.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
