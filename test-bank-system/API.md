# Bank System API Documentation

## Base URL
```
http://localhost:<PORT>/api
```

## Authentication
Currently no authentication required. (Add JWT/OAuth before production)

---

## Loan Management Endpoints

### 1. Submit Loan Application
**POST** `/loans/apply`

Submit a new loan application for review.

**Request Body:**
```json
{
  "applicantId": "string (required)",
  "amount": "number (required)",
  "interestRate": "number (optional, default: 5.5)",
  "term": "number (optional, default: 60 months)"
}
```

**Response (201):**
```json
{
  "id": "uuid",
  "applicantId": "string",
  "status": "submitted",
  "loanAmount": 50000,
  "interestRate": 6.5,
  "term": 60,
  "createdAt": "2026-05-12T10:00:00Z",
  "updatedAt": "2026-05-12T10:00:00Z",
  "reviewNotes": [],
  "documents": []
}
```

---

### 2. Get Loan Application
**GET** `/loans/{applicationId}`

Retrieve details of a specific loan application.

**Response (200):**
```json
{
  "id": "uuid",
  "applicantId": "string",
  "status": "submitted|underReview|waitingForInfo|approved|rejected|disbursed",
  "loanAmount": 50000,
  "interestRate": 6.5,
  "term": 60,
  "createdAt": "ISO 8601 timestamp",
  "updatedAt": "ISO 8601 timestamp"
}
```

---

### 3. Start Loan Review
**PUT** `/loans/{applicationId}/review`

Begin the review process for a submitted application.

**Request Body:**
```json
{
  "reviewerId": "string (required)"
}
```

**Response (200):**
```json
{
  "status": "underReview",
  "reviewerId": "string",
  "reviewStartedAt": "ISO 8601 timestamp"
}
```

---

### 4. Request Additional Information
**PUT** `/loans/{applicationId}/request-info`

Request additional documents or information from applicant.

**Request Body:**
```json
{
  "documents": ["string"] (required)
}
```

**Example:**
```json
{
  "documents": [
    "Tax Returns - Last 2 Years",
    "Employment Letter",
    "Bank Statements"
  ]
}
```

**Response (200):**
```json
{
  "status": "waitingForInfo",
  "requiredDocuments": ["string"]
}
```

---

### 5. Provide Information
**PUT** `/loans/{applicationId}/provide-info`

Submit requested documents/information.

**Request Body:**
```json
{
  "documents": ["string"] (required)
}
```

**Response (200):**
```json
{
  "status": "underReview",
  "documents": ["string"],
  "infoProvidedAt": "ISO 8601 timestamp"
}
```

---

### 6. Approve Loan Application
**PUT** `/loans/{applicationId}/approve`

Approve a loan application.

**Request Body:**
```json
{
  "approverId": "string (required)"
}
```

**Response (200):**
```json
{
  "status": "approved",
  "approverId": "string",
  "approvalAmount": 50000,
  "approvedAt": "ISO 8601 timestamp"
}
```

---

### 7. Reject Loan Application
**PUT** `/loans/{applicationId}/reject`

Reject a loan application with reason.

**Request Body:**
```json
{
  "reason": "string (required)"
}
```

**Response (200):**
```json
{
  "status": "rejected",
  "rejectionReason": "string",
  "rejectedAt": "ISO 8601 timestamp"
}
```

---

### 8. Disburse Loan
**PUT** `/loans/{applicationId}/disburse`

Disburse an approved loan to an account.

**Request Body:**
```json
{
  "accountId": "string (required)"
}
```

**Response (200):**
```json
{
  "status": "disbursed",
  "disbursedTo": "account-id",
  "disbursedAt": "ISO 8601 timestamp"
}
```

---

### 9. Get Applicant Loans
**GET** `/loans/applicant/{applicantId}`

Retrieve all loan applications for a specific applicant.

**Response (200):**
```json
{
  "applications": [
    {
      "id": "uuid",
      "status": "string",
      "loanAmount": 50000
    }
  ],
  "count": 1
}
```

---

## Account Management Endpoints

### 1. Create Account
**POST** `/accounts`

Create a new bank account.

**Request Body:**
```json
{
  "customerId": "string (required)",
  "type": "savings|checking (optional, default: savings)",
  "currency": "string (optional, default: USD)"
}
```

**Response (201):**
```json
{
  "id": "uuid",
  "customerId": "string",
  "status": "pending",
  "accountType": "savings",
  "currency": "USD",
  "balance": 0,
  "createdAt": "ISO 8601 timestamp",
  "updatedAt": "ISO 8601 timestamp"
}
```

---

### 2. Get Account
**GET** `/accounts/{accountId}`

Retrieve account details.

**Response (200):**
```json
{
  "id": "uuid",
  "customerId": "string",
  "status": "pending|verifying|active|suspended|closureRequested|closed|rejected",
  "accountType": "savings",
  "currency": "USD",
  "balance": 0,
  "createdAt": "ISO 8601 timestamp",
  "updatedAt": "ISO 8601 timestamp"
}
```

---

### 3. Verify Identity
**PUT** `/accounts/{accountId}/verify`

Start identity verification for an account.

**Request Body:**
```json
{
  "documentId": "string (required)",
  "documentType": "string (required)"
}
```

**Response (200):**
```json
{
  "status": "verifying",
  "verificationData": {
    "documentId": "string",
    "documentType": "string"
  }
}
```

---

### 4. Activate Account
**PUT** `/accounts/{accountId}/activate`

Complete verification and activate account.

**Response (200):**
```json
{
  "status": "active",
  "verificationStatus": "passed",
  "verifiedAt": "ISO 8601 timestamp"
}
```

---

### 5. Suspend Account
**PUT** `/accounts/{accountId}/suspend`

Temporarily suspend an account.

**Request Body:**
```json
{
  "reason": "string (required)"
}
```

**Response (200):**
```json
{
  "status": "suspended",
  "suspensionReason": "string",
  "suspendedAt": "ISO 8601 timestamp"
}
```

---

### 6. Reactivate Account
**PUT** `/accounts/{accountId}/reactivate`

Reactivate a suspended account.

**Response (200):**
```json
{
  "status": "active",
  "reactivatedAt": "ISO 8601 timestamp"
}
```

---

### 7. Request Account Closure
**PUT** `/accounts/{accountId}/request-close`

Initiate account closure request.

**Response (200):**
```json
{
  "status": "closureRequested",
  "closureRequestedAt": "ISO 8601 timestamp"
}
```

---

### 8. Confirm Account Closure
**PUT** `/accounts/{accountId}/confirm-close`

Confirm and permanently close account.

**Response (200):**
```json
{
  "status": "closed",
  "closedAt": "ISO 8601 timestamp"
}
```

---

### 9. Get Customer Accounts
**GET** `/accounts/customer/{customerId}`

Retrieve all accounts for a customer.

**Response (200):**
```json
{
  "accounts": [
    {
      "id": "uuid",
      "status": "active",
      "balance": 10000
    }
  ],
  "count": 1
}
```

---

## Transaction Endpoints

### 1. Initiate Transaction
**POST** `/transactions`

Create a new transaction.

**Request Body:**
```json
{
  "sourceAccount": "string (required)",
  "destinationAccount": "string (optional for deposits)",
  "amount": "number (required)",
  "type": "deposit|withdrawal|transfer (required)",
  "description": "string (optional)",
  "reference": "string (optional)"
}
```

**Response (201):**
```json
{
  "id": "uuid",
  "sourceAccount": "string",
  "destinationAccount": "string",
  "amount": 5000,
  "currency": "USD",
  "type": "transfer",
  "status": "initiated",
  "createdAt": "ISO 8601 timestamp",
  "updatedAt": "ISO 8601 timestamp"
}
```

---

### 2. Get Transaction
**GET** `/transactions/{transactionId}`

Retrieve transaction details.

**Response (200):**
```json
{
  "id": "uuid",
  "sourceAccount": "string",
  "destinationAccount": "string",
  "amount": 5000,
  "type": "transfer",
  "status": "initiated|validating|authorized|processing|pending|settled|failed",
  "createdAt": "ISO 8601 timestamp",
  "updatedAt": "ISO 8601 timestamp"
}
```

---

### 3. Validate Transaction
**PUT** `/transactions/{transactionId}/validate`

Validate transaction details.

**Response (200):**
```json
{
  "status": "validating",
  "validatedAt": "ISO 8601 timestamp"
}
```

---

### 4. Authorize Transaction
**PUT** `/transactions/{transactionId}/authorize`

Authorize a validated transaction.

**Response (200):**
```json
{
  "status": "authorized",
  "authorizedAt": "ISO 8601 timestamp"
}
```

---

### 5. Process Transaction
**PUT** `/transactions/{transactionId}/process`

Start processing an authorized transaction.

**Response (200):**
```json
{
  "status": "processing",
  "processingStartedAt": "ISO 8601 timestamp"
}
```

---

### 6. Settle Transaction
**PUT** `/transactions/{transactionId}/settle`

Successfully settle a transaction.

**Response (200):**
```json
{
  "status": "settled",
  "settledAt": "ISO 8601 timestamp"
}
```

---

### 7. Fail Transaction
**PUT** `/transactions/{transactionId}/fail`

Mark a transaction as failed.

**Request Body:**
```json
{
  "errorMessage": "string (required)"
}
```

**Response (200):**
```json
{
  "status": "failed",
  "errorMessage": "string",
  "failedAt": "ISO 8601 timestamp"
}
```

---

### 8. Get Account Transactions
**GET** `/transactions/account/{accountId}`

Retrieve all transactions for an account.

**Response (200):**
```json
{
  "transactions": [
    {
      "id": "uuid",
      "amount": 5000,
      "status": "settled"
    }
  ],
  "count": 5
}
```

---

### 9. Get Transactions by Status
**GET** `/transactions/status/{status}`

Retrieve transactions by status.

Available statuses: `initiated`, `validating`, `authorized`, `processing`, `pending`, `settled`, `failed`

**Response (200):**
```json
{
  "transactions": [
    {
      "id": "uuid",
      "status": "pending",
      "amount": 5000
    }
  ],
  "count": 3
}
```

---

## Error Responses

### 400 Bad Request
```json
{
  "error": "applicantId and amount are required"
}
```

### 404 Not Found
```json
{
  "error": "Loan application not found: {id}"
}
```

### 500 Server Error
```json
{
  "error": "Internal server error message"
}
```

---

## Status Codes

| Code | Meaning |
|------|---------|
| 200 | OK - Successful request |
| 201 | Created - Resource successfully created |
| 400 | Bad Request - Invalid request body or parameters |
| 404 | Not Found - Resource doesn't exist |
| 500 | Server Error - Internal error |

---

## Rate Limiting
Currently no rate limiting. (Implement before production)

---

## Pagination
Currently no pagination. (Implement for large datasets)

---

## Integration with StateKeep

This API is designed to work standalone initially, then integrate with StateKeep for:
- Distributed state management
- Actor-based processing
- Event sourcing
- Multi-instance deployments

See main README for integration guide.
