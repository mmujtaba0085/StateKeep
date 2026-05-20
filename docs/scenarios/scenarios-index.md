# StateKeep — Scenarios Index

> Tracks all migration scenarios: tested, documented, and planned.

---

## Status Key

| Symbol | Meaning |
|---|---|
| ✅ | Tested end-to-end on live VPS |
| 📄 | Documentation written |
| 🔵 | Planned — not yet tested |

---

## Tested Scenarios

### Scenario 1 — Support Tickets (`ticket`)
**Status:** ✅ Tested · 📄 Documented (`docs/scenarios/scenario-1-tickets.md`)

Demonstrates the full additive → breaking → rescue → stateMapping flow.

| Version | Change | Type | Result |
|---|---|---|---|
| ticket-v1 | Base: open→assigned→in_progress→resolved | — | 20 actors spawned, distributed across states |
| ticket-v2 | Adds `escalated` state and new transitions | Additive | All 18 active actors migrated, 0 stranded |
| ticket-v3 | Removes `in_progress` (merged into `assigned`) | **Breaking** | 8 actors stranded → `requires_confirmation` returned |
| ticket-v3 (confirmed) | Same definition, confirmed with token | Confirmation | 8 actors tagged `needs_rescue` |
| ticket-v3 (refinement) | Same ID, adds `stateMapping: { in_progress: assigned }` | Rescue | 8 actors remapped to `assigned`, all land on v3 active |

**Key concepts shown:** additive migration, `requires_confirmation` flow, `confirmToken`, `needs_rescue`, `stateMapping` rescue, definition refinement at same `t_star`.

---

### Scenario 2 — Loan Applications (`loan`)
**Status:** ✅ Tested · 📄 Documented (`docs/scenarios/scenario-2-loans.md`)

Demonstrates `historyPath` surgical targeting across a multi-version chain.

| Version | historyPath | Targeted | Result |
|---|---|---|---|
| loan-v1 | None (wildcard) | — | 20 actors spawned, distributed: idle/application/underwriting/active/repaid |
| loan-v2 | `["APPLY"]` | Actors with exactly `[APPLY]` history | Only 4 `application`-state actors migrated to v2 — underwriting/active actors untouched |
| loan-v3 | `["APPLY","SUBMIT","INCOME_OK"]` | Actors who passed income check | 4 actors advanced through income_check, then migrated to v3 with `compliance_review` gate |

**Key concepts shown:** historyPath targeting, surgical migration (in-flight actors with longer histories not disrupted), multi-version chains, fingerprint-based routing.

---

## Planned Scenarios

### Scenario 3 — Shuffle + Remove + Add (Complex Migration)
**Status:** 🔵 Planned

The hardest migration type — all three structural changes happen simultaneously.

**Setup:**
```
v1: step1 → step2 → step3 → step4 → step5
v2: step1 → step3 → step6 → step4 → step5
```
Changes: `step2` removed, `step6` added between step3 and step4, `step3` shuffled earlier.

**What to test:**

| Actor position at deploy | Expected behaviour |
|---|---|
| `step1` | Migrates, takes full new path: step3→step6→step4→step5 |
| `step2` | Stranded → `requires_confirmation` → rescued via `stateMapping` |
| `step3` | Migrates, gets forced through new `step6` on next transition |
| `step4` | Migrates cleanly, continues step4→step5 |
| `step5` (final) | Untouched |

**Key things to verify:**
- System catches the `step2` removal and returns `requires_confirmation` ✓ (expected)
- System does NOT warn about the shuffle or addition (silent changes) — verify this
- Actors in `step3` at deploy time hit `step6` retroactively — verify this is the actual behaviour
- Test `stateMapping` options for stranded `step2` actors: map to `step3` (goes through step6) vs map to `step4` (skips step6) — both should work, result differs by business intent

**Key concepts to demonstrate:** silent trap of shuffle+add on in-flight actors, the difference between loud failures (removal) and silent reroutes (shuffle), why complex migrations should be split into two deploys.

**Recommended split approach:**
1. Deploy v1→v1.5: handle removal only (`step2` removed, `stateMapping` provided)
2. Deploy v1.5→v2: add `step6` + shuffle `step3` with `historyPath` targeting only fresh actors

---

### Scenario 4 — historyPath + stateMapping Together
**Status:** 🔵 Planned

Tests using both `historyPath` and `stateMapping` in the same deployment — targeting only a subset of actors AND remapping a renamed state for that subset.

**Setup:** A machine where one path renames a state and another path doesn't. Only actors on the renamed path need rescuing; the rest migrate cleanly.

**Key concept:** combining surgical targeting with rescue in a single deploy.

---

### Scenario 5 — Chain Migration (v1 → v2 → v3 in rapid succession)
**Status:** 🔵 Planned

Deploys v2 and v3 before v1 actors finish migrating to v2. Tests that the migrate-worker correctly chains actors through v1→v2→v3 without skipping a version or double-migrating.

**Key concept:** migration job ordering under rapid re-deployment, `logicalStartTick` correctness across chained migrations.

---

### Scenario 6 — Large-Scale Migration (performance baseline)
**Status:** 🔵 Planned

Spawns 5,000 actors across a machine family, deploys a new version, and measures end-to-end migration time.

**Baseline targets (after adaptive poll interval fix):**
- 1,000 actors → < 5s
- 5,000 actors → < 20s
- 20,000 actors → < 60s

**Key concept:** validates migration speed fix (adaptive 50ms/500ms poll interval), establishes performance baseline before Postgres migration.

---

## Notes

- All tested scenarios were run against the live VPS at `https://statekeep.161-97-163-210.nip.io`
- Actor simulation scripts: `scripts/spawn-tickets.js`, `scripts/spawn-loans.js`
- Scenario curl commands: `docs/scenarios/scenario-1-tickets.md`, `docs/scenarios/scenario-2-loans.md`
- DB is wiped between scenario runs using the inline sqlite3 wipe + `seed-key.mjs` pattern
