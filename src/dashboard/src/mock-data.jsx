/* global React */

// ============ ORG / MACHINES ============
const MOCK_ORGS = [
  { id: "org_4f8a2b1c", name: "Meridian Financial", tier: "Growth" },
  { id: "org_8b3d1e5a", name: "Northwind Insurance", tier: "Enterprise" },
  { id: "org_2c9f4a7b", name: "Sequoia Lending", tier: "Pro" }
];

const MOCK_ORG = {
  id: "org_4f8a2b1c",
  name: "Meridian Financial",
  tier: "Growth",
  apiKey: "sk_live_8a2b1c9f7d3e4f5a6b7c8d9e0f1a2b3c",
  plan: {
    actorsLimit: 100000, actorsUsed: 30843,
    eventsLimit: 10000000, eventsUsed: 847291
  }
};

const MOCK_MACHINES = [
  { id: "loan", name: "Loan Application", family: "loan",
    active: 4203, migrating: 12, rescue: 0,
    currentVersion: "loan-v3",
    versions: [
      { id: "loan-v1", active: 0, deprecated: true },
      { id: "loan-v2", active: 89, deprecated: false,
        children: [{ id: "loan-v2-rescue", active: 0, deprecated: false }] },
      { id: "loan-v3", active: 4114, deprecated: false, current: true }
    ],
    spark: [12, 18, 14, 22, 19, 28, 24, 30, 27, 33, 31, 36, 38, 42, 45] },
  { id: "order", name: "Order Processing", family: "order",
    active: 18441, migrating: 0, rescue: 3,
    currentVersion: "order-v2",
    versions: [
      { id: "order-v1", active: 0, deprecated: true },
      { id: "order-v2", active: 18441, deprecated: false, current: true }
    ],
    spark: [142, 138, 145, 151, 149, 156, 162, 168, 174, 180, 178, 184, 188, 192, 196] },
  { id: "onboarding", name: "User Onboarding", family: "onboarding",
    active: 892, migrating: 0, rescue: 0,
    currentVersion: "onboarding-v2",
    versions: [
      { id: "onboarding-v1", active: 0, deprecated: true },
      { id: "onboarding-v2", active: 892, deprecated: false, current: true }
    ],
    spark: [42, 48, 51, 55, 49, 58, 62, 60, 66, 64, 70, 68, 72, 78, 82] },
  { id: "subscription", name: "Subscription Mgmt", family: "subscription",
    active: 7104, migrating: 89, rescue: 0,
    currentVersion: "subscription-v4",
    versions: [
      { id: "subscription-v1", active: 0, deprecated: true },
      { id: "subscription-v2", active: 0, deprecated: true },
      { id: "subscription-v3", active: 89, deprecated: false },
      { id: "subscription-v4", active: 7015, deprecated: false, current: true }
    ],
    spark: [62, 58, 65, 71, 69, 76, 82, 88, 94, 100, 98, 104, 108, 112, 116] },
  { id: "claims", name: "Insurance Claims", family: "claims",
    active: 1203, migrating: 0, rescue: 7,
    currentVersion: "claims-v1",
    versions: [
      { id: "claims-v1", active: 1203, deprecated: false, current: true }
    ],
    spark: [18, 22, 19, 25, 21, 28, 24, 31, 28, 35, 32, 38, 36, 42, 40] }
];

// ============ STATE DIAGRAMS ============
const MOCK_LOAN_STATES_V3 = {
  nodes: [
    { id: "idle",          type: "initial", x: 60,  y: 220, count: 0 },
    { id: "application",   type: "normal",  x: 230, y: 220, count: 847 },
    { id: "underwriting",  type: "normal",  x: 410, y: 220, count: 1203 },
    { id: "income_verify", type: "normal",  x: 600, y: 110, count: 412, isNew: true },
    { id: "awaiting_docs", type: "normal",  x: 600, y: 330, count: 1203 },
    { id: "approved",      type: "final",   x: 790, y: 110, count: 312 },
    { id: "rejected",      type: "final",   x: 790, y: 330, count: 226 }
  ],
  edges: [
    { from: "idle",          to: "application",   evt: "START_APPLICATION" },
    { from: "application",   to: "underwriting",  evt: "SUBMIT" },
    { from: "underwriting",  to: "income_verify", evt: "PAY_FEE" },
    { from: "underwriting",  to: "awaiting_docs", evt: "WAIVE_FEE" },
    { from: "income_verify", to: "awaiting_docs", evt: "INCOME_VERIFIED" },
    { from: "awaiting_docs", to: "approved",      evt: "APPROVE" },
    { from: "awaiting_docs", to: "rejected",      evt: "REJECT" }
  ]
};

const MOCK_ORDER_STATES = {
  nodes: [
    { id: "cart",       type: "initial", x: 60,  y: 220, count: 0 },
    { id: "checkout",   type: "normal",  x: 230, y: 220, count: 4231 },
    { id: "paid",       type: "normal",  x: 410, y: 220, count: 6802 },
    { id: "packing",    type: "normal",  x: 580, y: 220, count: 3401 },
    { id: "shipped",    type: "normal",  x: 750, y: 220, count: 4007 },
    { id: "delivered",  type: "final",   x: 750, y: 90,  count: 0 },
    { id: "cancelled",  type: "final",   x: 750, y: 350, count: 0 }
  ],
  edges: [
    { from: "cart",      to: "checkout",  evt: "CHECKOUT" },
    { from: "checkout",  to: "paid",      evt: "PAY" },
    { from: "paid",      to: "packing",   evt: "WAREHOUSE_PICK" },
    { from: "packing",   to: "shipped",   evt: "DISPATCH" },
    { from: "shipped",   to: "delivered", evt: "DELIVER" },
    { from: "checkout",  to: "cancelled", evt: "ABANDON" }
  ]
};

const MOCK_ONBOARDING_STATES = {
  nodes: [
    { id: "signup",        type: "initial", x: 60,  y: 220, count: 0 },
    { id: "email_verify",  type: "normal",  x: 230, y: 220, count: 412 },
    { id: "profile",       type: "normal",  x: 410, y: 220, count: 280 },
    { id: "preferences",   type: "normal",  x: 590, y: 220, count: 124 },
    { id: "activated",     type: "final",   x: 770, y: 110, count: 76 },
    { id: "abandoned",     type: "final",   x: 770, y: 330, count: 0 }
  ],
  edges: [
    { from: "signup",       to: "email_verify", evt: "SIGNUP" },
    { from: "email_verify", to: "profile",      evt: "VERIFY_EMAIL" },
    { from: "profile",      to: "preferences",  evt: "SAVE_PROFILE" },
    { from: "preferences",  to: "activated",    evt: "FINISH" },
    { from: "email_verify", to: "abandoned",    evt: "TIMEOUT" }
  ]
};

const MOCK_SUBSCRIPTION_STATES = {
  nodes: [
    { id: "trial",         type: "initial", x: 60,  y: 220, count: 1842 },
    { id: "active",        type: "normal",  x: 250, y: 220, count: 4720 },
    { id: "past_due",      type: "normal",  x: 440, y: 110, count: 281 },
    { id: "paused",        type: "normal",  x: 440, y: 330, count: 172 },
    { id: "cancelled",     type: "final",   x: 640, y: 330, count: 0 },
    { id: "churned",       type: "final",   x: 640, y: 110, count: 0 }
  ],
  edges: [
    { from: "trial",     to: "active",    evt: "CONVERT" },
    { from: "active",    to: "past_due",  evt: "PAYMENT_FAILED" },
    { from: "active",    to: "paused",    evt: "PAUSE" },
    { from: "past_due",  to: "churned",   evt: "EXPIRE" },
    { from: "paused",    to: "cancelled", evt: "CANCEL" },
    { from: "past_due",  to: "active",    evt: "PAYMENT_RETRY" }
  ]
};

const MOCK_CLAIMS_STATES = {
  nodes: [
    { id: "filed",        type: "initial", x: 60,  y: 220, count: 218 },
    { id: "assessment",   type: "normal",  x: 240, y: 220, count: 481 },
    { id: "investigation", type: "normal", x: 430, y: 220, count: 312 },
    { id: "review",       type: "normal",  x: 620, y: 220, count: 192 },
    { id: "paid",         type: "final",   x: 800, y: 110, count: 0 },
    { id: "denied",       type: "final",   x: 800, y: 330, count: 0 }
  ],
  edges: [
    { from: "filed",         to: "assessment",   evt: "FILE_CLAIM" },
    { from: "assessment",    to: "investigation", evt: "ESCALATE" },
    { from: "investigation", to: "review",       evt: "EVIDENCE_GATHERED" },
    { from: "review",        to: "paid",         evt: "APPROVE" },
    { from: "review",        to: "denied",       evt: "DENY" }
  ]
};

const STATES_BY_FAMILY = {
  loan: MOCK_LOAN_STATES_V3,
  order: MOCK_ORDER_STATES,
  onboarding: MOCK_ONBOARDING_STATES,
  subscription: MOCK_SUBSCRIPTION_STATES,
  claims: MOCK_CLAIMS_STATES
};

// ============ ACTIVITY FEED ============
const MOCK_FEED_BASE = [
  { evt: "APPROVE",   color: "green",  actor: "a4f2b8c1", target: "approved" },
  { evt: "SUBMIT",    color: "blue",   actor: "c7d9e2f4", target: "underwriting" },
  { evt: "MIGRATED",  color: "purple", actor: "b3a1c5d8", target: "loan-v3" },
  { evt: "WAIVE_FEE", color: "blue",   actor: "e8f2a4b6", target: "awaiting_docs" },
  { evt: "PAY_FEE",   color: "blue",   actor: "d1c3b7a9", target: "income_verify" },
  { evt: "REJECT",    color: "red",    actor: "f5e8d2c1", target: "rejected" },
  { evt: "SCHEDULED", color: "amber",  actor: "a9b4c7d2", target: "(EXPIRE+72h)" },
  { evt: "APPROVE",   color: "green",  actor: "b2c8d4e6", target: "approved" },
  { evt: "DISPATCH",  color: "blue",   actor: "7e3a9b1f", target: "shipped" },
  { evt: "CONVERT",   color: "green",  actor: "9c4d8e2a", target: "active" },
  { evt: "MIGRATED",  color: "purple", actor: "4b8f1c6d", target: "subscription-v4" },
  { evt: "FILE_CLAIM",color: "blue",   actor: "2a5e9b3c", target: "assessment" },
  { evt: "PAYMENT_FAILED", color: "amber", actor: "6d8c4a1b", target: "past_due" },
  { evt: "SIGNUP",    color: "blue",   actor: "1f5e8a3d", target: "email_verify" }
];

// ============ WORKERS ============
const MOCK_WORKERS = [
  { name: "migrate-worker",    pid: 12847, lastBeat: 8,  uptime: "3d 14h 22m" },
  { name: "gc-worker",         pid: 12849, lastBeat: 12, uptime: "3d 14h 22m" },
  { name: "scheduler-worker",  pid: 12851, lastBeat: 4,  uptime: "3d 14h 22m" },
  { name: "webhook-worker",    pid: 12853, lastBeat: 3,  uptime: "3d 14h 22m" },
  { name: "snapshot-worker",   pid: 12855, lastBeat: 28, uptime: "3d 14h 22m" },
  { name: "metrics-worker",    pid: 12857, lastBeat: 9,  uptime: "3d 14h 22m" },
  { name: "heartbeat",         pid: 12859, lastBeat: 2,  uptime: "3d 14h 22m" }
];

// ============ ACTORS ============
const MOCK_ACTORS = [
  { id: "a4f2b8c19d3e",  machine: "Loan Application",  version: "v3", state: "income_verify", status: "active",       lastEvt: "PAY_FEE",    lastTime: "2m ago",  age: "2 days" },
  { id: "c7d9e2f4a1b8",  machine: "Loan Application",  version: "v3", state: "underwriting",  status: "active",       lastEvt: "SUBMIT",     lastTime: "14m ago", age: "1 day" },
  { id: "b3a1c5d8f2e4",  machine: "Order Processing",  version: "v2", state: "awaiting_docs", status: "needs_rescue", lastEvt: "MIGRATED",   lastTime: "1h ago",  age: "5 days" },
  { id: "e8f2a4b6c1d3",  machine: "Subscription Mgmt", version: "v4", state: "trial",         status: "migrating",    lastEvt: "CONVERT",    lastTime: "8m ago",  age: "12 days" },
  { id: "d1c3b7a9e5f2",  machine: "Insurance Claims",  version: "v1", state: "assessment",    status: "active",       lastEvt: "FILE_CLAIM", lastTime: "3h ago",  age: "7 days" },
  { id: "f5e8d2c1a4b9",  machine: "User Onboarding",   version: "v2", state: "email_verify",  status: "active",       lastEvt: "SIGNUP",     lastTime: "22m ago", age: "3h" },
  { id: "a9b4c7d2e6f5",  machine: "Order Processing",  version: "v2", state: "shipped",       status: "active",       lastEvt: "SHIP",       lastTime: "45m ago", age: "6 days" },
  { id: "b2c8d4e6a1f3",  machine: "Loan Application",  version: "v3", state: "approved",      status: "active",       lastEvt: "APPROVE",    lastTime: "2h ago",  age: "8 days" }
];

// Pre-baked event history for the drawer
const MOCK_ACTOR_HISTORY = {
  "a4f2b8c19d3e": [
    { type: "system", evt: "SPAWN",            time: "2 days ago", payload: '{ "applicantId": "u_8a3f" }' },
    { type: "user",   evt: "START_APPLICATION", time: "2 days ago", payload: '{}' },
    { type: "user",   evt: "SUBMIT",           time: "1 day ago",  payload: '{ "amount": 240000 }' },
    { type: "user",   evt: "PAY_FEE",          time: "2m ago",     payload: '{ "amount": 49.0 }' }
  ]
};

// ============ MIGRATION INTEL ============
const MOCK_DEPLOYMENTS = [
  { id: "dep_8a3f2b", from: "loan-v2", to: "loan-v3", time: "12m ago",  status: "complete", evaluated: 4203, migrated: 2891, stayed: 1242, failed: 70 },
  { id: "dep_4c9e1d", from: "subscription-v3", to: "subscription-v4", time: "2h ago", status: "complete", evaluated: 7193, migrated: 7104, stayed: 89, failed: 0 },
  { id: "dep_2b7d8a", from: "order-v1", to: "order-v2", time: "1d ago", status: "complete", evaluated: 18441, migrated: 18441, stayed: 0, failed: 0 },
  { id: "dep_9f1a4c", from: "onboarding-v1", to: "onboarding-v2", time: "3d ago", status: "complete", evaluated: 892, migrated: 892, stayed: 0, failed: 0 }
];

const MOCK_DECISIONS = [
  { id: "a4f2b8c1", path: "...PAY_FEE",   decision: "MIGRATED", reason: "fingerprint_match",    target: "loan-v3" },
  { id: "c7d9e2f4", path: "...WAIVE_FEE", decision: "STAYED",   reason: "fingerprint_mismatch", target: "—" },
  { id: "b3a1c5d8", path: "...PAY_FEE",   decision: "MIGRATED", reason: "fingerprint_match",    target: "loan-v3" },
  { id: "e8f2a4b6", path: "...CANCEL",    decision: "FAILED",   reason: "state_not_mappable",   target: "—" },
  { id: "d1c3b7a9", path: "...WAIVE_FEE", decision: "STAYED",   reason: "fingerprint_mismatch", target: "—" },
  { id: "f5e8d2c1", path: "...PAY_FEE",   decision: "MIGRATED", reason: "fingerprint_match",    target: "loan-v3" },
  { id: "a9b4c7d2", path: "...WAIVE_FEE", decision: "STAYED",   reason: "fingerprint_mismatch", target: "—" },
  { id: "b2c8d4e6", path: "...PAY_FEE",   decision: "MIGRATED", reason: "fingerprint_match",    target: "loan-v3" }
];

// Migration timeline data (cumulative migrated over seconds since deploy)
const MOCK_MIGRATION_TIMELINE = (() => {
  const arr = [];
  for (let t = 0; t <= 45; t++) {
    const migrated = t <= 8 ? Math.round(2891 * Math.min(1, t / 8)) : 2891;
    const remaining = 4203 - migrated;
    arr.push({ t, migrated, remaining });
  }
  return arr;
})();

// ============ METRICS PAGE DATA ============
const MOCK_ACTOR_TIMELINE_30D = (() => {
  const arr = [];
  for (let i = 0; i < 30; i++) {
    const base = 25000 + i * 200 + Math.sin(i / 3) * 800;
    arr.push({
      day: `D-${29 - i}`,
      spawns: Math.round(base + Math.random() * 400),
      terminations: Math.round(base * 0.7 + Math.random() * 300),
      net: 0
    });
  }
  arr.forEach(d => d.net = d.spawns - d.terminations);
  return arr;
})();

const MOCK_EVENT_VOLUME_7D = (() => {
  const days = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];
  return days.map(d => ({
    day: d,
    SUBMIT: Math.round(40000 + Math.random() * 20000),
    APPROVE: Math.round(28000 + Math.random() * 12000),
    PAY: Math.round(35000 + Math.random() * 18000),
    SIGNUP: Math.round(15000 + Math.random() * 8000),
    MIGRATED: Math.round(2000 + Math.random() * 1500),
    Other: Math.round(20000 + Math.random() * 10000)
  }));
})();

const MOCK_DECISION_HISTORY = [
  { dep: "dep_8a3f", migrated: 2891, stayed: 1242, failed: 70 },
  { dep: "dep_4c9e", migrated: 7104, stayed: 89, failed: 0 },
  { dep: "dep_2b7d", migrated: 18441, stayed: 0, failed: 0 },
  { dep: "dep_9f1a", migrated: 892, stayed: 0, failed: 0 },
  { dep: "dep_5e2b", migrated: 1183, stayed: 18, failed: 2 },
  { dep: "dep_3a8d", migrated: 4421, stayed: 215, failed: 8 },
  { dep: "dep_7c1f", migrated: 6802, stayed: 312, failed: 1 },
  { dep: "dep_1b4e", migrated: 9241, stayed: 482, failed: 14 },
  { dep: "dep_6d9a", migrated: 3128, stayed: 92, failed: 0 },
  { dep: "dep_8e5c", migrated: 2104, stayed: 38, failed: 0 }
];

const MOCK_MACHINE_DIST = MOCK_MACHINES.map(m => ({ name: m.name, value: m.active }));

const MOCK_WEBHOOK_DELIVERY_7D = (() => {
  const days = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];
  return days.map(d => ({ day: d, success: 99.2 + Math.random() * 0.7 }));
})();

const MOCK_WEBHOOKS = [
  { url: "https://api.meridian.fi/hooks/loan-events",    events: ["actor.transitioned","actor.terminated"], active: true,  failures: 0,  lastDelivery: "12s ago" },
  { url: "https://ops.meridian.fi/slack/migrations",      events: ["deployment.completed","actor.rescue"], active: true,  failures: 0,  lastDelivery: "2m ago" },
  { url: "https://billing.meridian.fi/subscription-evt",  events: ["actor.transitioned"], active: true,  failures: 3,  lastDelivery: "8m ago" },
  { url: "https://legacy.meridian.fi/v1/webhooks/orders", events: ["actor.transitioned"], active: false, failures: 142, lastDelivery: "4h ago" }
];

const MOCK_ACTIVITY_LOG = [
  { ts: "12:42:18", type: "DEPLOYMENT",         details: "loan-v3 deployed by petra@meridian.fi", org: "Meridian Financial" },
  { ts: "12:42:26", type: "MIGRATION_COMPLETE", details: "2,891 actors migrated to loan-v3 in 8.3s", org: "Meridian Financial" },
  { ts: "12:38:04", type: "WEBHOOK_FAILURE",    details: "POST https://billing.../subscription-evt → 503",  org: "Meridian Financial" },
  { ts: "12:31:55", type: "WORKER_RESTART",     details: "snapshot-worker auto-restarted (stale 142s)", org: "Meridian Financial" },
  { ts: "12:18:09", type: "RESCUE",             details: "7 actors flagged needs_rescue on claims-v1",   org: "Meridian Financial" },
  { ts: "11:55:42", type: "DEPLOYMENT",         details: "subscription-v4 deployed by ops@meridian.fi",  org: "Meridian Financial" },
  { ts: "11:55:48", type: "MIGRATION_COMPLETE", details: "7,104 actors migrated to subscription-v4",     org: "Meridian Financial" }
];

const MOCK_API_KEYS = [
  { label: "Production",  id: "sk_live_8a2b...3c9e", tier: "Live",  created: "Jan 14, 2026", lastUsed: "8s ago" },
  { label: "CI / Deploy", id: "sk_live_4f1d...7a2b", tier: "Live",  created: "Mar 02, 2026", lastUsed: "4m ago" },
  { label: "Staging",     id: "sk_test_9c3e...1f8a", tier: "Test",  created: "Mar 18, 2026", lastUsed: "2h ago" },
  { label: "Local dev",   id: "sk_test_2b7d...4e1c", tier: "Test",  created: "Apr 05, 2026", lastUsed: "1d ago" }
];

// ============ SCHEDULED EVENTS (drawer) ============
const MOCK_SCHEDULED = [
  { evt: "EXPIRE",        actor: "a4f2b8c1", fires: "in 2d 14h" },
  { evt: "AUTO_APPROVE",  actor: "a4f2b8c1", fires: "in 6h 12m" }
];

window.MOCK_ORGS = MOCK_ORGS;
window.MOCK_ORG = MOCK_ORG;
window.MOCK_MACHINES = MOCK_MACHINES;
window.STATES_BY_FAMILY = STATES_BY_FAMILY;
window.MOCK_FEED_BASE = MOCK_FEED_BASE;
window.MOCK_WORKERS = MOCK_WORKERS;
window.MOCK_ACTORS = MOCK_ACTORS;
window.MOCK_ACTOR_HISTORY = MOCK_ACTOR_HISTORY;
window.MOCK_DEPLOYMENTS = MOCK_DEPLOYMENTS;
window.MOCK_DECISIONS = MOCK_DECISIONS;
window.MOCK_MIGRATION_TIMELINE = MOCK_MIGRATION_TIMELINE;
window.MOCK_ACTOR_TIMELINE_30D = MOCK_ACTOR_TIMELINE_30D;
window.MOCK_EVENT_VOLUME_7D = MOCK_EVENT_VOLUME_7D;
window.MOCK_DECISION_HISTORY = MOCK_DECISION_HISTORY;
window.MOCK_MACHINE_DIST = MOCK_MACHINE_DIST;
window.MOCK_WEBHOOK_DELIVERY_7D = MOCK_WEBHOOK_DELIVERY_7D;
window.MOCK_WEBHOOKS = MOCK_WEBHOOKS;
window.MOCK_ACTIVITY_LOG = MOCK_ACTIVITY_LOG;
window.MOCK_API_KEYS = MOCK_API_KEYS;
window.MOCK_SCHEDULED = MOCK_SCHEDULED;
