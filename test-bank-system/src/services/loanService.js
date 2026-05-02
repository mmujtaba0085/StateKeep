const { v4: uuidv4 } = require('uuid');

/**
 * In-memory store for loans (replace with database later)
 */
const loanStore = new Map();

/**
 * Loan Service - Handles loan application workflows
 */
class LoanService {
  /**
   * Submit a new loan application
   */
  static submitApplication(applicantId, loanData) {
    const applicationId = uuidv4();
    
    const application = {
      id: applicationId,
      applicantId,
      status: 'submitted',
      loanAmount: loanData.amount,
      interestRate: loanData.interestRate || 5.5,
      term: loanData.term || 60, // months
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      reviewNotes: [],
      documents: []
    };

    loanStore.set(applicationId, application);
    console.log(`[LoanService] New loan application submitted: ${applicationId}`);
    
    return application;
  }

  /**
   * Get loan application by ID
   */
  static getApplication(applicationId) {
    const application = loanStore.get(applicationId);
    if (!application) {
      throw new Error(`Loan application not found: ${applicationId}`);
    }
    return application;
  }

  /**
   * Start review of a loan application
   */
  static startReview(applicationId, reviewerId) {
    const application = this.getApplication(applicationId);
    
    if (application.status !== 'submitted') {
      throw new Error(`Cannot review application in status: ${application.status}`);
    }

    application.status = 'underReview';
    application.reviewerId = reviewerId;
    application.reviewStartedAt = new Date().toISOString();
    application.updatedAt = new Date().toISOString();
    
    console.log(`[LoanService] Review started for application: ${applicationId}`);
    return application;
  }

  /**
   * Request additional information from applicant
   */
  static requestMoreInfo(applicationId, requiredDocuments) {
    const application = this.getApplication(applicationId);
    
    if (application.status !== 'underReview') {
      throw new Error(`Cannot request info for application in status: ${application.status}`);
    }

    application.status = 'waitingForInfo';
    application.requiredDocuments = requiredDocuments;
    application.infoRequestedAt = new Date().toISOString();
    application.updatedAt = new Date().toISOString();
    
    console.log(`[LoanService] Additional info requested for: ${applicationId}`);
    return application;
  }

  /**
   * Provide requested information
   */
  static provideInformation(applicationId, documents) {
    const application = this.getApplication(applicationId);
    
    if (application.status !== 'waitingForInfo') {
      throw new Error(`Application not waiting for info. Current status: ${application.status}`);
    }

    application.status = 'underReview';
    application.documents = [...(application.documents || []), ...documents];
    application.infoProvidedAt = new Date().toISOString();
    application.updatedAt = new Date().toISOString();
    
    console.log(`[LoanService] Information provided for: ${applicationId}`);
    return application;
  }

  /**
   * Approve a loan application
   */
  static approveApplication(applicationId, approverId) {
    const application = this.getApplication(applicationId);
    
    if (application.status !== 'underReview') {
      throw new Error(`Cannot approve application in status: ${application.status}`);
    }

    application.status = 'approved';
    application.approverId = approverId;
    application.approvedAt = new Date().toISOString();
    application.approvalAmount = application.loanAmount;
    application.updatedAt = new Date().toISOString();
    
    console.log(`[LoanService] Application approved: ${applicationId}`);
    return application;
  }

  /**
   * Reject a loan application
   */
  static rejectApplication(applicationId, reason) {
    const application = this.getApplication(applicationId);
    
    if (!['underReview', 'approved'].includes(application.status)) {
      throw new Error(`Cannot reject application in status: ${application.status}`);
    }

    application.status = 'rejected';
    application.rejectionReason = reason;
    application.rejectedAt = new Date().toISOString();
    application.updatedAt = new Date().toISOString();
    
    console.log(`[LoanService] Application rejected: ${applicationId} - Reason: ${reason}`);
    return application;
  }

  /**
   * Disburse approved loan
   */
  static disburseLoans(applicationId, accountId) {
    const application = this.getApplication(applicationId);
    
    if (application.status !== 'approved') {
      throw new Error(`Cannot disburse application in status: ${application.status}`);
    }

    application.status = 'disbursed';
    application.disbursedTo = accountId;
    application.disbursedAt = new Date().toISOString();
    application.updatedAt = new Date().toISOString();
    
    console.log(`[LoanService] Loan disbursed: ${applicationId} to account: ${accountId}`);
    return application;
  }

  /**
   * Get all applications for an applicant
   */
  static getApplicationsByApplicant(applicantId) {
    return Array.from(loanStore.values()).filter(
      app => app.applicantId === applicantId
    );
  }

  /**
   * Clear store (for testing)
   */
  static clearStore() {
    loanStore.clear();
  }
}

module.exports = LoanService;
