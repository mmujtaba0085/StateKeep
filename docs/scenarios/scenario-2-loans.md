# Scenario 2 — Loan Application Processing

This scenario demonstrates **historyPath-targeted migration** — the core APV differentiator. You deploy three versions of a loan workflow, and each version only migrates actors whose event history matches a specific path.

**What you'll see:**
- Deploy loan-v1 (basic loan flow, 10 states)
- Spawn 20 loan actors at various lifecycle stages
- Deploy loan-v2 (adds income verification — targeted with historyPath)
- Deploy loan-v3 (adds compliance review — even more targeted historyPath)
- Observe: old actors (without income verification in their history) stay on their version; new actors get the full flow

**Set this once** before running any commands:
```bash
export API_KEY="sk_live_2b6cb4591bcac04c3caed5b2c37b3a6ed94b6c8c"
export BASE="https://statekeep.161-97-163-210.nip.io"
```

---

## Step 1 — Deploy loan-v1

Classic loan processing: application → underwriting → approved → active → closed.

```bash
curl -s -X PUT "$BASE/v1/definitions" \
  -H "x-api-key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "loan-v1",
    "definition": {
      "initial": "idle",
      "states": {
        "idle": {
          "on": {
            "APPLY": "application"
          }
        },
        "application": {
          "on": {
            "SUBMIT": "underwriting",
            "CANCEL": "cancelled"
          }
        },
        "underwriting": {
          "on": {
            "APPROVE": "approved",
            "REJECT":  "rejected"
          }
        },
        "approved": {
          "on": {
            "DISBURSE": "active"
          }
        },
        "active": {
          "on": {
            "REPAY":   "repaid",
            "DEFAULT": "defaulted"
          }
        },
        "cancelled":  { "type": "final" },
        "rejected":   { "type": "final" },
        "repaid":     { "type": "final" },
        "defaulted":  { "type": "final" }
      }
    }
  }' | jq .
```

**Expected:** `201` with `"id": "loan-v1"`, `"affectedActors": 0`

---

## Step 2 — Spawn and populate loan actors

```bash
node scripts/spawn-loans.js
```

Watch the dashboard's Actor Explorer. After the script, actors should be distributed across:
- `idle` — 3 actors (just created, not applied yet)
- `application` — 4 actors (applied, form in progress)
- `underwriting` — 6 actors (submitted, under review)
- `approved` — 4 actors (approved, awaiting disbursement)
- `active` — 2 actors (loan disbursed, in repayment)
- `repaid` — 1 actor (final)

---

## Step 3 — Verify the actors

```bash
# Count actors by state (look at the response)
curl -s "$BASE/v1/actors?limit=50" \
  -H "x-api-key: $API_KEY" | jq '[.actors[] | select(.definitionId == "loan-v1")] | group_by(.stateValue) | map({state: .[0].stateValue, count: length})'
```

---

## Step 4 — Deploy loan-v2 (adds income verification, historyPath targeted)

**What changes:** The flow now routes newly submitted applications through an `income_check` step before underwriting. **But** — actors already in `underwriting` or further along skipped income check. We don't want to disrupt them. `historyPath: ["APPLY"]` means only actors whose history starts with `APPLY` are eligible for this version. Since ALL loan actors have `APPLY` in their history, this migrates everyone — but the income_check step is only *encountered* by actors who haven't submitted yet.

> **Key insight:** The `income_check` state is inserted between `application` and `underwriting`. Actors already past `application` (in `underwriting`, `approved`, `active`) will still exist in those same states in loan-v2 — they just naturally skip income_check because they're already past it.

```bash
curl -s -X PUT "$BASE/v1/definitions" \
  -H "x-api-key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "loan-v2",
    "parentId": "loan-v1",
    "definition": {
      "initial": "idle",
      "states": {
        "idle": {
          "on": {
            "APPLY": "application"
          }
        },
        "application": {
          "on": {
            "SUBMIT": "income_check",
            "CANCEL": "cancelled"
          }
        },
        "income_check": {
          "on": {
            "INCOME_VERIFIED": "underwriting",
            "INCOME_FAILED":   "rejected"
          }
        },
        "underwriting": {
          "on": {
            "APPROVE": "approved",
            "REJECT":  "rejected"
          }
        },
        "approved": {
          "on": {
            "DISBURSE": "active"
          }
        },
        "active": {
          "on": {
            "REPAY":   "repaid",
            "DEFAULT": "defaulted"
          }
        },
        "cancelled":  { "type": "final" },
        "rejected":   { "type": "final" },
        "repaid":     { "type": "final" },
        "defaulted":  { "type": "final" }
      }
    }
  }' | jq .
```

**Expected:** `201` — all non-final actors migrate to loan-v2.

---

## Step 5 — Move some actors through income_check

Take actors currently in `application` state (there should be ~4 from the spawn script) and submit them. They will now go through `income_check` first:

```bash
# Replace APPLICATION_ACTOR_ID with an actor ID from the dashboard in state "application"

# Submit the application → goes to income_check (NEW step in v2)
curl -s -X POST "$BASE/v1/actors/APPLICATION_ACTOR_ID/event" \
  -H "x-api-key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"type": "SUBMIT", "payload": {"submittedAt": "2025-05-19"}}' | jq '{state: .stateValue}'

# Verify income → goes to underwriting
curl -s -X POST "$BASE/v1/actors/APPLICATION_ACTOR_ID/event" \
  -H "x-api-key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"type": "INCOME_VERIFIED", "payload": {"verifiedBy": "bureau_api", "score": 720}}' | jq '{state: .stateValue}'
```

**Expected state after SUBMIT:** `income_check` (the new step!)
**Expected state after INCOME_VERIFIED:** `underwriting`

---

## Step 6 — Check event history of an income-verified actor

```bash
curl -s "$BASE/v1/actors/APPLICATION_ACTOR_ID/events" \
  -H "x-api-key: $API_KEY" | jq '[.events[] | {type: .type, at: .processedAt}]'
```

**Expected output** — notice the full history including INCOME_VERIFIED:
```json
[
  { "type": "SPAWN",            "at": 1716163200000 },
  { "type": "APPLY",            "at": 1716163201000 },
  { "type": "SUBMIT",           "at": 1716163260000 },
  { "type": "INCOME_VERIFIED",  "at": 1716163320000 }
]
```

This event history fingerprint (`APPLY → SUBMIT → INCOME_VERIFIED`) is exactly what loan-v3 will use as its `historyPath`.

---

## Step 7 — Deploy loan-v3 (adds compliance review, surgically targeted)

**What changes:** Adds `compliance_review` step between `underwriting` and `approved`. But — this should ONLY apply to actors who went through income verification (history contains `INCOME_VERIFIED`). Old v1-era actors that went straight from `application` to `underwriting` (no income check) should remain on loan-v2 without the compliance step.

`historyPath: ["APPLY", "SUBMIT", "INCOME_VERIFIED"]` targets only actors with that exact event sequence in their history.

```bash
curl -s -X PUT "$BASE/v1/definitions" \
  -H "x-api-key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "loan-v3",
    "parentId": "loan-v2",
    "historyPath": ["APPLY", "SUBMIT", "INCOME_VERIFIED"],
    "definition": {
      "initial": "idle",
      "states": {
        "idle": {
          "on": {
            "APPLY": "application"
          }
        },
        "application": {
          "on": {
            "SUBMIT": "income_check",
            "CANCEL": "cancelled"
          }
        },
        "income_check": {
          "on": {
            "INCOME_VERIFIED": "underwriting",
            "INCOME_FAILED":   "rejected"
          }
        },
        "underwriting": {
          "on": {
            "APPROVE": "compliance_review",
            "REJECT":  "rejected"
          }
        },
        "compliance_review": {
          "on": {
            "PASS": "approved",
            "FAIL": "rejected"
          }
        },
        "approved": {
          "on": {
            "DISBURSE": "active"
          }
        },
        "active": {
          "on": {
            "REPAY":   "repaid",
            "DEFAULT": "defaulted"
          }
        },
        "cancelled":  { "type": "final" },
        "rejected":   { "type": "final" },
        "repaid":     { "type": "final" },
        "defaulted":  { "type": "final" }
      }
    }
  }' | jq .
```

**Expected:** `201` — only actors with `INCOME_VERIFIED` in their history migrate to loan-v3. Old v1-era actors stay on loan-v2.

---

## Step 8 — Observe the split

Check the Machines page in the dashboard. You should see:
- `loan-v2`: actors that predate income verification (old flow, no income_check history)
- `loan-v3`: only actors that went through `INCOME_VERIFIED`

Verify via API:
```bash
curl -s "$BASE/v1/actors?limit=50" \
  -H "x-api-key: $API_KEY" | jq '[.actors[] | {id: .id, def: .definitionId, state: .stateValue}] | group_by(.def)'
```

---

## Step 9 — Move a v3 actor through compliance_review

Take an actor now on loan-v3 in `underwriting` state and push it through the new compliance step:

```bash
# UNDERWRITING_ACTOR_ID must be an actor on loan-v3 in state "underwriting"

# Approve underwriting → goes to compliance_review (NEW step in v3!)
curl -s -X POST "$BASE/v1/actors/UNDERWRITING_ACTOR_ID/event" \
  -H "x-api-key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"type": "APPROVE", "payload": {"underwriter": "john_doe", "riskScore": 42}}' | jq '{state: .stateValue}'

# Pass compliance → goes to approved
curl -s -X POST "$BASE/v1/actors/UNDERWRITING_ACTOR_ID/event" \
  -H "x-api-key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"type": "PASS", "payload": {"reviewedBy": "compliance_team"}}' | jq '{state: .stateValue}'

# Disburse the loan
curl -s -X POST "$BASE/v1/actors/UNDERWRITING_ACTOR_ID/event" \
  -H "x-api-key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"type": "DISBURSE", "payload": {"amount": 250000, "disbursedAt": "2025-05-19"}}' | jq '{state: .stateValue}'
```

**Expected states:** `compliance_review` → `approved` → `active`

---

## Step 10 — Contrast: move a v2 actor through underwriting (no compliance step)

Take an old v1-era actor on loan-v2 that's in `underwriting`:

```bash
# OLD_UNDERWRITING_ACTOR_ID must be on loan-v2 (no INCOME_VERIFIED in history)

curl -s -X POST "$BASE/v1/actors/OLD_UNDERWRITING_ACTOR_ID/event" \
  -H "x-api-key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"type": "APPROVE"}' | jq '{state: .stateValue, def: .migratedTo}'
```

**Expected state: `approved`** — skips compliance_review because this actor is on loan-v2 which doesn't have that step. The event history fingerprint didn't match the `historyPath` for loan-v3.

---

## Summary — What you demonstrated

| Step | Feature |
|---|---|
| Deploy loan-v1 | Multi-state real-world machine |
| Spawn + populate | 20 actors at different lifecycle stages |
| Deploy loan-v2 | Additive migration — income_check inserted mid-flow |
| Move through income_check | New step is live, actor event history builds up |
| Deploy loan-v3 with historyPath | Surgical targeting — only actors with `INCOME_VERIFIED` in history get compliance_review |
| Check the split | loan-v2 and loan-v3 both have active actors based on their history |
| Full v3 flow | compliance_review → approved → active |
| v2 comparison | Old actors skip compliance_review, go straight to approved |

### The APV differentiator

Two actors both in state `underwriting` receive **different migration decisions** because one has `INCOME_VERIFIED` in its history and the other doesn't. This is impossible with version-number-based or state-only migration systems. StateKeep routes actors based on *path*, not just current position.
