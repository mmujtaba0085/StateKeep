/**
 * Random workflow generator for the generic chaos simulation.
 *
 * Produces statecharts for arbitrary domains (not one business): nested states,
 * a parallel block, guarded and eventless transitions, timers, entry actions with
 * side effects (each with its own delivery mode and follow-up event), final states —
 * and then evolves them into new versions the way teams do (add a step, rename a
 * state, reroute a path for actors that took a specific history).
 *
 * Everything is driven by the seeded `rng` passed in, so a seed reproduces the lot.
 */
import { compileMachine } from '../../../src/runtime/definitionCompiler.js';

export const DOMAINS = {
  order: {
    states: ['cart', 'checkout', 'payment', 'packing', 'shipping', 'in_transit', 'delivered', 'returning', 'refunded', 'on_hold', 'backorder', 'fraud_check'],
    events: ['ADD_ITEM', 'PAY', 'PAYMENT_OK', 'PAYMENT_FAILED', 'PACK', 'SHIP', 'SCAN', 'DELIVER', 'RETURN', 'HOLD', 'RELEASE', 'CANCEL'],
    actions: ['reserveStock', 'chargeCustomer', 'printLabel', 'notifyCourier', 'emailReceipt'],
  },
  ci_pipeline: {
    states: ['queued', 'checkout', 'build', 'unit_tests', 'integration', 'staging', 'canary', 'production', 'rolled_back', 'flaky_retry', 'approval', 'blocked'],
    events: ['START', 'BUILD_OK', 'BUILD_FAIL', 'TESTS_PASS', 'TESTS_FAIL', 'DEPLOY', 'PROMOTE', 'ROLLBACK', 'APPROVE', 'RETRY', 'TIMEOUT_ACK', 'ABORT'],
    actions: ['runBuild', 'deployStaging', 'notifySlack', 'openIncident', 'tagRelease'],
  },
  support_ticket: {
    states: ['new', 'triage', 'assigned', 'waiting_customer', 'investigating', 'escalated', 'resolved', 'reopened', 'closed', 'sla_breach', 'merged', 'spam'],
    events: ['ASSIGN', 'REPLY', 'CUSTOMER_REPLY', 'ESCALATE', 'RESOLVE', 'REOPEN', 'CLOSE', 'MERGE', 'MARK_SPAM', 'NUDGE', 'PRIORITY_UP', 'TRANSFER'],
    actions: ['sendAutoReply', 'pageOnCall', 'syncCrm', 'surveyCustomer', 'updateSlaClock'],
  },
  iot_device: {
    states: ['provisioned', 'pairing', 'online', 'updating', 'degraded', 'offline', 'maintenance', 'quarantined', 'retired', 'rebooting', 'calibrating', 'idle'],
    events: ['PAIR', 'HEARTBEAT', 'FW_AVAILABLE', 'FW_OK', 'FW_FAIL', 'ALERT', 'LOST', 'FOUND', 'SERVICE', 'QUARANTINE', 'RETIRE', 'CALIBRATE'],
    actions: ['pushFirmware', 'rotateKeys', 'notifyOwner', 'recordTelemetry', 'dispatchTechnician'],
  },
  clinical_trial: {
    states: ['screening', 'consent', 'enrolled', 'randomized', 'dosing', 'follow_up', 'adverse_event', 'withdrawn', 'completed', 'monitoring', 'visit_due', 'data_review'],
    events: ['SCREEN_OK', 'SCREEN_FAIL', 'CONSENT', 'RANDOMIZE', 'DOSE', 'VISIT', 'AE_REPORTED', 'AE_RESOLVED', 'WITHDRAW', 'COMPLETE', 'QUERY', 'LOCK'],
    actions: ['notifySponsor', 'scheduleVisit', 'reportToIrb', 'shipKit', 'unblindCheck'],
  },
  insurance_claim: {
    states: ['filed', 'intake', 'assessment', 'inspection', 'negotiation', 'approved', 'denied', 'appeal', 'paid', 'fraud_review', 'documents', 'closed'],
    events: ['SUBMIT', 'ASSESS', 'INSPECT', 'OFFER', 'ACCEPT', 'REJECT', 'APPEAL', 'PAY', 'FLAG', 'DOCS', 'WITHDRAW', 'REOPEN'],
    actions: ['orderInspection', 'issuePayment', 'notifyAdjuster', 'requestDocuments', 'recordReserve'],
  },
  hiring: {
    states: ['applied', 'screen', 'phone', 'onsite', 'debrief', 'offer', 'negotiating', 'hired', 'rejected', 'withdrawn', 'reference_check', 'on_hold'],
    events: ['SCREEN', 'PASS', 'FAIL', 'SCHEDULE', 'FEEDBACK', 'OFFER', 'COUNTER', 'ACCEPT', 'DECLINE', 'WITHDRAW', 'HOLD', 'RESUME'],
    actions: ['sendInvite', 'createOffer', 'runBackgroundCheck', 'notifyRecruiter', 'provisionLaptop'],
  },
  content_moderation: {
    states: ['submitted', 'auto_scan', 'human_review', 'published', 'removed', 'appealed', 'restored', 'shadow_limited', 'escalated', 'archived', 'pending_edit', 'expired'],
    events: ['SCAN_OK', 'SCAN_FLAG', 'REVIEW', 'APPROVE', 'REMOVE', 'APPEAL', 'RESTORE', 'LIMIT', 'ESCALATE', 'EDIT', 'EXPIRE', 'REPORT'],
    actions: ['notifyAuthor', 'hashMedia', 'escalateToLegal', 'updateTrustScore', 'purgeCaches'],
  },
};

export const FIELDS = ['score', 'count', 'level'];
const DELIVERY = [['idempotent', 0.3], ['verify', 0.35], ['at-most-once', 0.35]];

export function makeRng(seed) {
  let s = seed >>> 0;
  const rnd = () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const api = {
    rnd,
    pick: (a) => a[Math.floor(rnd() * a.length)],
    pickW: (pairs) => { let r = rnd() * pairs.reduce((x, [, w]) => x + w, 0); for (const [v, w] of pairs) { if ((r -= w) <= 0) return v; } return pairs[0][0]; },
    int: (a, b) => a + Math.floor(rnd() * (b - a + 1)),
    chance: (p) => rnd() < p,
    shuffle: (a) => { const c = [...a]; for (let i = c.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [c[i], c[j]] = [c[j], c[i]]; } return c; },
  };
  return api;
}

const clone = (x) => JSON.parse(JSON.stringify(x));

/**
 * Generate v1 of a workflow.
 * Returns { id, domain, definition, actions: { name: { delivery, followUp } }, events, features }.
 */
export function generateWorkflow(rng, domainName, id) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const wf = tryGenerate(rng, domainName, id);
    try { compileMachine(wf.definition); return wf; } catch { /* regenerate */ }
  }
  throw new Error(`could not generate a compilable workflow for ${domainName}`);
}

function tryGenerate(rng, domainName, id) {
  const dom = DOMAINS[domainName];
  const names = rng.shuffle(dom.states);
  const events = rng.shuffle(dom.events).slice(0, rng.int(7, 10));
  const nTop = rng.int(5, 8);
  const top = names.slice(0, nTop);
  const finals = ['done', ...(rng.chance(0.5) ? ['cancelled'] : [])];
  const actions = {};
  for (const a of rng.shuffle(dom.actions).slice(0, rng.int(2, 4))) {
    actions[a] = { delivery: rng.pickW(DELIVERY), followUp: rng.pick(events) };
  }
  const features = new Set();
  const states = {};
  const guardFor = () => `cond: context.${rng.pick(FIELDS)} ${rng.pick(['>', '<', '>=', '=='])} ${rng.int(1, 6)}`;

  const transitionsFor = (self, siblings, outside) => {
    const on = {};
    for (const ev of rng.shuffle(events).slice(0, rng.int(1, 4))) {
      const target = rng.chance(0.75) ? rng.pick(outside) : rng.pick(siblings.filter((x) => x !== self).concat([self]));
      if (rng.chance(0.3)) {
        features.add('guards');
        const alt = rng.pick(outside);
        on[ev] = rng.chance(0.5) ? [{ target, guard: guardFor() }, { target: alt }] : [{ target, guard: guardFor() }];
      } else on[ev] = target;
    }
    return on;
  };

  const allTargets = [...top, ...finals];
  for (const name of top) {
    const st = {};
    const kind = rng.pickW([['atomic', 0.62], ['compound', 0.23], ['parallel', 0.15]]);
    if (kind === 'compound') {
      features.add('nested');
      const kids = ['step_a', 'step_b', 'step_c'].slice(0, rng.int(2, 3));
      st.initial = kids[0];
      st.states = {};
      for (const k of kids) {
        const inner = {};
        const on = {};
        for (const ev of rng.shuffle(events).slice(0, rng.int(0, 2))) on[ev] = rng.pick(kids.filter((x) => x !== k).concat([k]));
        if (Object.keys(on).length) inner.on = on;
        st.states[k] = inner;
      }
      st.on = transitionsFor(name, top, allTargets.filter((x) => x !== name));
    } else if (kind === 'parallel' && !Object.values(states).some((s) => s.type === 'parallel')) {
      features.add('parallel');
      st.type = 'parallel';
      st.states = {};
      for (const region of ['left', 'right']) {
        const a = `${region}_open`, b = `${region}_ready`;
        st.states[region] = { initial: a, states: { [a]: { on: { [rng.pick(events)]: b } }, [b]: { type: 'final' } } };
      }
      st.on = transitionsFor(name, top, allTargets.filter((x) => x !== name));
    } else {
      st.on = transitionsFor(name, top, allTargets);
      if (rng.chance(0.12)) {
        features.add('always');
        st.always = [{ target: rng.pick(allTargets.filter((x) => x !== name)), guard: guardFor() }];
      }
      if (rng.chance(0.15)) {
        features.add('timers');
        st.after = { [rng.pick([900, 1500, 2500])]: rng.pick(allTargets.filter((x) => x !== name)) };
      }
    }
    if (rng.chance(0.3) && Object.keys(actions).length) {
      features.add('actions');
      st.entry = [rng.pick(Object.keys(actions))];
    }
    states[name] = st;
  }
  for (const f of finals) states[f] = { type: 'final' };
  // make sure the actions' follow-up events do something somewhere (they usually do)
  return {
    id, domain: domainName,
    definition: { id: `${domainName}-${id}`, initial: top[0], context: { score: 0, count: 0, level: 0 }, states },
    actions, events, features: [...features],
  };
}

/** Top-level atomic, non-final state names of a definition. */
export const atomicTop = (def) => Object.entries(def.states).filter(([, s]) => !s.states && s.type !== 'final').map(([n]) => n);

function renameEverywhere(def, from, to) {
  const s = JSON.stringify(def).replaceAll(`"${from}"`, `"${to}"`);
  return JSON.parse(s);
}

/**
 * Evolve a workflow into its next version. `livePaths` are real event-type histories of
 * live actors on the current version (to target a historyPath at). Returns
 * { kind, definition, stateMapping?, contextTransform?, historyPath? } or null.
 */
export function evolve(rng, wf, currentDef, livePaths) {
  const kinds = [['add_step', 0.3], ['rename', 0.25], ['reroute_for_history', 0.3], ['copy_field', 0.15]];
  for (let attempt = 0; attempt < 20; attempt++) {
    const kind = rng.pickW(kinds);
    let def = clone(currentDef);
    delete def._stateMapping; delete def._contextTransform; delete def._historyPath;
    const out = { kind };
    if (kind === 'add_step') {
      const from = rng.pick(Object.keys(def.states).filter((n) => def.states[n].type !== 'final'));
      const name = `extra_${rng.int(100, 999)}`;
      def.states[name] = { on: { [rng.pick(wf.events)]: rng.pick(Object.keys(def.states)) } };
      def.states[from].on = { ...(def.states[from].on ?? {}), [rng.pick(wf.events)]: name };
    } else if (kind === 'rename') {
      const cands = atomicTop(def).filter((n) => n !== def.initial);
      if (!cands.length) continue;
      const from = rng.pick(cands);
      const to = `${from}_v${rng.int(2, 99)}`;
      def = renameEverywhere(def, from, to);
      out.stateMapping = { [from]: to };
    } else if (kind === 'reroute_for_history') {
      const paths = livePaths.filter((p) => p.length > 0);
      if (!paths.length) continue;
      out.historyPath = rng.pick(paths);
      const from = rng.pick(Object.keys(def.states).filter((n) => def.states[n].on && Object.keys(def.states[n].on).length));
      if (!from) continue;
      const ev = rng.pick(Object.keys(def.states[from].on));
      def.states[from].on[ev] = rng.pick(Object.keys(def.states).filter((n) => n !== from));
    } else if (kind === 'copy_field') {
      out.contextTransform = { [`prev_${rng.pick(['score', 'count', 'level'])}`]: rng.pick(['score', 'count', 'level']) };
      def.states[rng.pick(Object.keys(def.states))].description = `v-${rng.int(1, 1e6)}`;
    }
    try { compileMachine(def); } catch { continue; }
    out.definition = def;
    return out;
  }
  return null;
}
