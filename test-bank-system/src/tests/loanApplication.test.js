const LoanService = require('../services/loanService');

describe('Loan Service - Workflow Tests', () => {
  beforeEach(() => {
    LoanService.clearStore();
  });

  describe('Loan Application Submission', () => {
    test('should submit a new loan application', () => {
      const application = LoanService.submitApplication('customer-1', {
        amount: 50000,
        interestRate: 6.5,
        term: 60
      });

      expect(application).toBeDefined();
      expect(application.status).toBe('submitted');
      expect(application.loanAmount).toBe(50000);
      expect(application.applicantId).toBe('customer-1');
    });

    test('should track application metadata', () => {
      const application = LoanService.submitApplication('customer-1', {
        amount: 25000,
        interestRate: 5.5,
        term: 36
      });

      expect(application.createdAt).toBeDefined();
      expect(application.updatedAt).toBeDefined();
      expect(application.reviewNotes).toEqual([]);
    });
  });

  describe('Loan Application Review', () => {
    test('should start review of submitted application', () => {
      const application = LoanService.submitApplication('customer-1', { amount: 50000 });
      
      const reviewed = LoanService.startReview(application.id, 'reviewer-1');
      
      expect(reviewed.status).toBe('underReview');
      expect(reviewed.reviewerId).toBe('reviewer-1');
      expect(reviewed.reviewStartedAt).toBeDefined();
    });

    test('should request additional information', () => {
      const application = LoanService.submitApplication('customer-1', { amount: 50000 });
      LoanService.startReview(application.id, 'reviewer-1');

      const updated = LoanService.requestMoreInfo(application.id, [
        'Tax Returns - Last 2 Years',
        'Employment Letter',
        'Bank Statements'
      ]);

      expect(updated.status).toBe('waitingForInfo');
      expect(updated.requiredDocuments).toHaveLength(3);
    });

    test('should allow providing requested information', () => {
      const application = LoanService.submitApplication('customer-1', { amount: 50000 });
      LoanService.startReview(application.id, 'reviewer-1');
      LoanService.requestMoreInfo(application.id, ['Tax Returns']);

      const updated = LoanService.provideInformation(application.id, [
        'tax-return-2023.pdf',
        'employment-letter.pdf'
      ]);

      expect(updated.status).toBe('underReview');
      expect(updated.documents).toHaveLength(2);
    });
  });

  describe('Loan Approval/Rejection', () => {
    test('should approve a loan application', () => {
      const application = LoanService.submitApplication('customer-1', { amount: 50000 });
      LoanService.startReview(application.id, 'reviewer-1');

      const approved = LoanService.approveApplication(application.id, 'approver-1');

      expect(approved.status).toBe('approved');
      expect(approved.approverId).toBe('approver-1');
      expect(approved.approvalAmount).toBe(50000);
      expect(approved.approvedAt).toBeDefined();
    });

    test('should reject a loan application', () => {
      const application = LoanService.submitApplication('customer-1', { amount: 50000 });
      LoanService.startReview(application.id, 'reviewer-1');

      const rejected = LoanService.rejectApplication(
        application.id,
        'Income verification failed'
      );

      expect(rejected.status).toBe('rejected');
      expect(rejected.rejectionReason).toBe('Income verification failed');
    });

    test('should allow reapplying after rejection', () => {
      const application1 = LoanService.submitApplication('customer-1', { amount: 50000 });
      LoanService.startReview(application1.id, 'reviewer-1');
      LoanService.rejectApplication(application1.id, 'Income too low');

      // Reapply
      const application2 = LoanService.submitApplication('customer-1', { amount: 30000 });
      
      expect(application2.status).toBe('submitted');
      expect(application1.status).toBe('rejected');
    });
  });

  describe('Loan Disbursement', () => {
    test('should disburse an approved loan to an account', () => {
      const application = LoanService.submitApplication('customer-1', { amount: 50000 });
      LoanService.startReview(application.id, 'reviewer-1');
      LoanService.approveApplication(application.id, 'approver-1');

      const disbursed = LoanService.disburseLoans(application.id, 'account-123');

      expect(disbursed.status).toBe('disbursed');
      expect(disbursed.disbursedTo).toBe('account-123');
      expect(disbursed.disbursedAt).toBeDefined();
    });

    test('should not disburse non-approved loans', () => {
      const application = LoanService.submitApplication('customer-1', { amount: 50000 });

      expect(() => {
        LoanService.disburseLoans(application.id, 'account-123');
      }).toThrow();
    });
  });

  describe('Complete Workflow', () => {
    test('should complete full loan workflow from application to disbursement', () => {
      // Step 1: Submit application
      const application = LoanService.submitApplication('customer-1', {
        amount: 50000,
        interestRate: 6.5,
        term: 60
      });
      expect(application.status).toBe('submitted');

      // Step 2: Start review
      const reviewed = LoanService.startReview(application.id, 'reviewer-1');
      expect(reviewed.status).toBe('underReview');

      // Step 3: Request information
      const infoRequested = LoanService.requestMoreInfo(application.id, [
        'Tax Returns',
        'Bank Statements'
      ]);
      expect(infoRequested.status).toBe('waitingForInfo');

      // Step 4: Provide information
      const infoProvided = LoanService.provideInformation(application.id, [
        'tax-2023.pdf',
        'bank-statement.pdf'
      ]);
      expect(infoProvided.status).toBe('underReview');

      // Step 5: Approve
      const approved = LoanService.approveApplication(application.id, 'approver-1');
      expect(approved.status).toBe('approved');

      // Step 6: Disburse
      const disbursed = LoanService.disburseLoans(application.id, 'account-xyz');
      expect(disbursed.status).toBe('disbursed');
      expect(disbursed.disbursedTo).toBe('account-xyz');
    });
  });

  describe('Error Cases', () => {
    test('should throw error for non-existent application', () => {
      expect(() => {
        LoanService.getApplication('non-existent-id');
      }).toThrow('Loan application not found');
    });

    test('should not allow invalid state transitions', () => {
      const application = LoanService.submitApplication('customer-1', { amount: 50000 });
      
      expect(() => {
        LoanService.approveApplication(application.id, 'approver-1');
      }).toThrow('Cannot approve application in status: submitted');
    });
  });
});
