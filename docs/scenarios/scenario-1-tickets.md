# Scenario 1 — Support Ticket System

This scenario walks through the full StateKeep lifecycle using a help-desk ticket machine.

**What you'll see:**
- Deploy v1 (basic ticket flow)
- Spawn 20 actors and move them through various states
- Deploy v2 (additive — adds `escalated` state, zero rescue needed)
- Deploy v3 (breaking — removes `in_progress`, triggers rescue flow)
- Deploy v3-fixed (with `stateMapping` to show the clean rescue path)

**Set this once** before running any commands (replace with your own values):
```bash
export API_KEY="sk_your_api_key"
export BASE="https://your-statekeep-instance.com"
```

---

## Step 1 — Deploy ticket-v1

Basic ticket flow: open → assigned → in_progress → resolved.

```bash
curl -s -X PUT "$BASE/v1/definitions" \
  -H "x-api-key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "ticket-v1",
    "definition": {
      "initial": "open",
      "states": {
        "open": {
          "on": {
            "ASSIGN":  "assigned",
            "CLOSE":   "closed"
          }
        },
        "assigned": {
          "on": {
            "START":   "in_progress",
            "CLOSE":   "closed"
          }
        },
        "in_progress": {
          "on": {
            "RESOLVE": "resolved",
            "REOPEN":  "open"
          }
        },
        "resolved": { "type": "final" },
        "closed":   { "type": "final" }
      }
    }
  }' | jq .
```

**Expected:** `201` with `"id": "ticket-v1"`, `"affectedActors": 0`

---

## Step 2 — Spawn actors and populate states

Run the simulation script to spawn 20 actors and distribute them across all states:

```bash
node scripts/spawn-tickets.js
```

The script will print each actor ID as it creates and moves them. Watch the **Actor Explorer** in the dashboard while it runs.

**After the script, you should see actors in:**
- `open` — 5 actors (just opened, not yet assigned)
- `assigned` — 5 actors (assigned but not started)
- `in_progress` — 8 actors (actively being worked on)
- `resolved` — 2 actors (done)

---

## Step 3 — Verify in dashboard

Open `https://your-statekeep-instance.com/dashboard/` and check:
- **Command Centre**: actor count ≥ 20
- **Machines**: shows `ticket-v1` machine family with actor counts
- **Actor Explorer**: 20 actors, spread across states

---

## Step 4 — Deploy ticket-v2 (additive migration)

Adds the `escalated` state. No states are removed — all live actors migrate safely.

```bash
curl -s -X PUT "$BASE/v1/definitions" \
  -H "x-api-key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "ticket-v2",
    "parentId": "ticket-v1",
    "definition": {
      "initial": "open",
      "states": {
        "open": {
          "on": {
            "ASSIGN":  "assigned",
            "CLOSE":   "closed"
          }
        },
        "assigned": {
          "on": {
            "START":    "in_progress",
            "ESCALATE": "escalated",
            "CLOSE":    "closed"
          }
        },
        "in_progress": {
          "on": {
            "RESOLVE":  "resolved",
            "ESCALATE": "escalated",
            "REOPEN":   "open"
          }
        },
        "escalated": {
          "on": {
            "ASSIGN":   "assigned",
            "RESOLVE":  "resolved"
          }
        },
        "resolved": { "type": "final" },
        "closed":   { "type": "final" }
      }
    }
  }' | jq .
```

**Expected:** `201` with `"affectedActors": 18` (the 18 non-final actors migrate from v1 → v2).

**In the dashboard:**
- **Machines page**: ticket-v1 now shows 0 active, ticket-v2 shows 18 active
- **Migration Intel**: may briefly show actors in `migrating` status

---

## Step 5 — Move some actors to `escalated` (the new state)

Grab actor IDs from the dashboard or from the script output. Pick 3 actors in `assigned` or `in_progress` and escalate them:

```bash
# Replace ACTOR_ID_1, ACTOR_ID_2, ACTOR_ID_3 with real IDs from the dashboard

curl -s -X POST "$BASE/v1/actors/ACTOR_ID_1/event" \
  -H "x-api-key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"type": "ESCALATE", "payload": {"reason": "customer complaint"}}' | jq .stateValue

curl -s -X POST "$BASE/v1/actors/ACTOR_ID_2/event" \
  -H "x-api-key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"type": "ESCALATE", "payload": {"reason": "SLA breach"}}' | jq .stateValue
```

---

## Step 6 — Deploy ticket-v3 (BREAKING — rescue demo)

Removes `in_progress` state. Any actor currently in `in_progress` will be stranded.

### First attempt — preview only

```bash
curl -s -X PUT "$BASE/v1/definitions" \
  -H "x-api-key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "ticket-v3",
    "parentId": "ticket-v2",
    "definition": {
      "initial": "open",
      "states": {
        "open": {
          "on": {
            "ASSIGN":  "assigned",
            "CLOSE":   "closed"
          }
        },
        "assigned": {
          "on": {
            "RESOLVE":  "resolved",
            "ESCALATE": "escalated",
            "CLOSE":    "closed"
          }
        },
        "escalated": {
          "on": {
            "ASSIGN":  "assigned",
            "RESOLVE": "resolved"
          }
        },
        "resolved": { "type": "final" },
        "closed":   { "type": "final" }
      }
    }
  }' | jq .
```

**Expected: 200 (not 201) with requires_confirmation:**
```json
{
  "status": "requires_confirmation",
  "strandedActors": [
    { "currentState": "in_progress", "count": 8 }
  ],
  "safeActors": 10,
  "confirmToken": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  "expiresIn": 300,
  "message": "8 actors are in states that no longer exist..."
}
```

Copy the `confirmToken` value. You have 5 minutes to confirm.

### Confirm — tag stranded actors as needs_rescue

Replace `YOUR_CONFIRM_TOKEN` with the token from above:

```bash
curl -s -X PUT "$BASE/v1/definitions" \
  -H "x-api-key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "ticket-v3",
    "parentId": "ticket-v2",
    "confirmToken": "YOUR_CONFIRM_TOKEN",
    "definition": {
      "initial": "open",
      "states": {
        "open": {
          "on": {
            "ASSIGN":  "assigned",
            "CLOSE":   "closed"
          }
        },
        "assigned": {
          "on": {
            "RESOLVE":  "resolved",
            "ESCALATE": "escalated",
            "CLOSE":    "closed"
          }
        },
        "escalated": {
          "on": {
            "ASSIGN":  "assigned",
            "RESOLVE": "resolved"
          }
        },
        "resolved": { "type": "final" },
        "closed":   { "type": "final" }
      }
    }
  }' | jq .
```

**Expected: 201 with `"strandedTagged": 8`**

**In the dashboard:**
- Actor Explorer → filter by `needs_rescue` → 8 actors visible
- Each shows the rescue banner in the drawer

---

## Step 7 — Try to send an event to a rescued actor

```bash
# Pick any needs_rescue actor ID from the dashboard

curl -s -X POST "$BASE/v1/actors/RESCUED_ACTOR_ID/event" \
  -H "x-api-key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"type": "RESOLVE"}' | jq .
```

**Expected: 409**
```json
{
  "error": "Actor is in needs_rescue status",
  "code": "ACTOR_NEEDS_RESCUE"
}
```

---

## Step 8 — Deploy ticket-v3-fixed (with stateMapping)

This shows the CORRECT way to handle the rename. Deploy the same v3 definition but map `in_progress` → `assigned` so actors are remapped instead of stranded.

> **Note:** Since ticket-v3 is already deployed, we deploy this as `ticket-v3-fixed` with parent `ticket-v2` to demonstrate the concept. In a real workflow, you'd use stateMapping on the initial v3 deployment before confirming.

```bash
curl -s -X PUT "$BASE/v1/definitions" \
  -H "x-api-key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "ticket-v3-fixed",
    "parentId": "ticket-v2",
    "stateMapping": {
      "in_progress": "assigned"
    },
    "definition": {
      "initial": "open",
      "states": {
        "open": {
          "on": {
            "ASSIGN":  "assigned",
            "CLOSE":   "closed"
          }
        },
        "assigned": {
          "on": {
            "RESOLVE":  "resolved",
            "ESCALATE": "escalated",
            "CLOSE":    "closed"
          }
        },
        "escalated": {
          "on": {
            "ASSIGN":  "assigned",
            "RESOLVE": "resolved"
          }
        },
        "resolved": { "type": "final" },
        "closed":   { "type": "final" }
      }
    }
  }' | jq .
```

**Expected: 201 with `"strandedTagged": 0`** — actors from `in_progress` were remapped to `assigned`, no rescue needed.

---

## Step 9 — Manually rescue an actor

Pick one of the `needs_rescue` actors from Step 7 and reset it:

```bash
curl -s -X PATCH "$BASE/v1/actors/RESCUED_ACTOR_ID" \
  -H "x-api-key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"status": "active"}' | jq .status
```

**Expected:** `"active"` — actor is now unblocked and will migrate on next event.

---

## Summary — What you demonstrated

| Step | Feature |
|---|---|
| Deploy v1 | First-time definition deployment |
| Spawn + populate | Live actors across multiple states |
| Deploy v2 | Additive migration — zero rescue, all actors move forward |
| Use new `escalated` state | Live actors on new version, new transitions available |
| Deploy v3 (step 1) | Breaking change preview — `requires_confirmation` response |
| Deploy v3 (confirm) | Confirm-token flow — stranded actors tagged `needs_rescue` |
| 409 error | Event blocked on rescued actor |
| Deploy v3-fixed | `stateMapping` as the clean alternative to rescue |
| Manual rescue | PATCH actor back to active |
