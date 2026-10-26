/**
 * apv.js — Anchor-Point Versioning for SCCharts instances (prototype).
 *
 * The routing model of the APV paper (docs/apv.md), with SCCharts transitions as the
 * history alphabet:
 *   - an instance's history is the sequence of transition ids it took (tick.js);
 *   - its fingerprint is StateKeep's v2 chain (length-prefixed SHA-256) over those ids;
 *   - a deployment registers a change-point (family, t, pattern | wildcard, target, mapping);
 *   - before every tick (the synchronous "unit"), an instance is routed to a fixpoint:
 *     the earliest change-point of its family at or after its logical time whose pattern
 *     it matches (exact before wildcard at equal time); each hop sets ℓ := t + 1;
 *   - migration maps every active leaf (dotted keys, longest prefix wins), enters the
 *     initial states of regions that are new in the target, runs no entry actions, keeps
 *     outputs and history; a configuration that cannot be placed strands the instance;
 *   - a deployment that would strand instances needs consent for exactly those instances.
 */
import { createHash } from 'node:crypto';
import { initialConfiguration, react, activeLeaves } from './tick.js';

const H0 = createHash('sha256').update('statekeep.fp.v2|empty').digest();
function step(d, e) {
  const b = Buffer.from(String(e), 'utf8'); const len = Buffer.alloc(4); len.writeUInt32BE(b.length, 0);
  return createHash('sha256').update(d).update(len).update(b).digest();
}
/** StateKeep's v2 fingerprint of a history ("0" for the empty history). */
export function fingerprint(history) {
  let d = H0; for (const e of history) d = step(d, e);
  return history.length ? '2:' + d.toString('hex') : '0';
}

export class Registry {
  constructor() {
    this.versions = new Map();      // id → { id, family, chart, deployedAt }
    this.changepoints = [];         // { family, t, pattern, fp, target, mapping }
    this.instances = new Map();     // id → instance
    this.clock = 0;                 // logical deployment clock (one sequence, as in StateKeep)
    this.nextId = 1;
  }

  newest(family) {
    let best = null;
    for (const v of this.versions.values()) if (v.family === family && (!best || v.deployedAt > best.deployedAt)) best = v;
    return best;
  }

  /** Resolve a pattern written with short transition names ("WaitB->DoneB") against a chart. */
  resolvePattern(chart, pattern) {
    const ids = [];
    for (const v of chart.states.values()) for (const t of v.transitions) ids.push(t.id);
    return pattern.map((p) => {
      if (ids.includes(p)) return p;
      const [a, b] = p.split('->');
      const hits = ids.filter((id) => { const [s, t] = id.split('->'); return s.split('.').pop() === a && t.split('.').pop() === b; });
      if (hits.length !== 1) throw new Error(`pattern step "${p}": ${hits.length ? 'ambiguous' : 'no such transition'} in ${chart.name}${hits.length ? ': ' + hits.join(', ') : ''}`);
      return hits[0];
    });
  }

  candidate({ id, chart, historyPath = null, stateMapping = {}, resolveIn = null }) {
    if (this.versions.has(id)) throw new Error(`version ${id} exists (versions are immutable)`);
    const family = chart.name;
    const pattern = historyPath?.length ? this.resolvePattern(resolveIn ?? this.newest(family)?.chart ?? chart, historyPath) : null;
    const t = this.clock + 1;
    return { id, chart, family, t, pattern, fp: pattern ? fingerprint(pattern) : null, mapping: stateMapping };
  }

  /** Deploy: the first version of a family needs nothing; later ones register a change-point. */
  deploy(spec, { consent = null } = {}) {
    const c = this.candidate(spec);
    const hasParent = !!this.newest(c.family);
    if (hasParent) {
      const p = this.preview(spec);
      if (p.stranded.length) {
        const ok = consent && p.stranded.every((s) => consent.includes(s.id));
        if (!ok) return { deployed: false, preview: p, notInConsent: consent ? p.stranded.filter((s) => !consent.includes(s.id)).length : p.stranded.length };
      }
    }
    this.clock = c.t;
    this.versions.set(c.id, { id: c.id, family: c.family, chart: c.chart, deployedAt: c.t });
    if (hasParent) this.changepoints.push({ family: c.family, t: c.t, pattern: c.pattern, fp: c.fp, target: c.id, mapping: c.mapping });
    // background units: route every instance of the family now (late matchers move later)
    for (const inst of this.instances.values()) if (this.versions.get(inst.version).family === c.family) this.route(inst);
    return { deployed: true, t: c.t };
  }

  spawn(familyOrVersion) {
    const v = this.versions.get(familyOrVersion) ?? this.newest(familyOrVersion);
    if (!v) throw new Error(`no version ${familyOrVersion}`);
    const newestT = this.newest(v.family).deployedAt;
    const inst = { id: `i${this.nextId++}`, version: v.id, ell: newestT + 1, history: [], tick: 0, status: 'active' };
    initialConfiguration(v.chart, inst);
    this.instances.set(inst.id, inst);
    return inst;
  }

  /** The routing rule: earliest applicable change-point (exact before wildcard), or null. */
  acc(inst, extra = null) {
    if (inst.status === 'finished') return null;
    const fam = this.versions.get(inst.version)?.family ?? extra?.family;
    const fp = fingerprint(inst.history);
    let best = null;
    for (const c of extra ? [...this.changepoints, extra] : this.changepoints) {
      if (c.family !== fam || c.t < inst.ell) continue;
      if (c.pattern && c.fp !== fp) continue;
      if (!best || c.t < best.t || (c.t === best.t && best.pattern === null && c.pattern !== null)) best = c;
    }
    return best;
  }

  /** Map the instance's configuration into `chart`; null if it cannot be placed. */
  place(fromChart, inst, chart, mapping) {
    const keys = Object.keys(mapping).sort((a, b) => b.length - a.length);
    const mapped = [];
    for (const leaf of activeLeaves(fromChart, inst)) {
      const k = keys.find((key) => leaf === key || leaf.startsWith(key + '.'));
      const p = k ? mapping[k] + leaf.slice(k.length) : leaf;
      const target = chart.states.get(p) ?? (k ? chart.states.get(mapping[k]) : null);
      if (!target) return null;
      mapped.push(target);
    }
    // active set: mapped states, their ancestors, and initial descendants where needed
    const active = new Set();
    const addAncestors = (path) => { const parts = path.split('.'); for (let i = 1; i <= parts.length; i++) { const a = parts.slice(0, i).join('.'); if (chart.states.has(a)) active.add(a); } };
    for (const s of mapped) addAncestors(s.path);
    const fill = (s) => {
      for (const r of s.regions) {
        const kids = r.states.filter((x) => active.has(x.path));
        if (kids.length > 1) return false;                         // two leaves in one region: conflict
        const k = kids[0] ?? r.states.find((x) => x.initial);
        active.add(k.path);
        if (!fill(k)) return false;
      }
      return true;
    };
    for (const r of chart.root.regions) {
      const kids = r.states.filter((x) => active.has(x.path));
      if (kids.length !== 1) return null;
      if (!fill(kids[0])) return null;
    }
    return active;
  }

  migrate(inst, c) {
    const from = this.versions.get(inst.version).chart;
    const to = (this.versions.get(c.target) ?? this._pending)?.chart;
    const active = this.place(from, inst, to, c.mapping);
    inst.version = c.target;
    inst.ell = c.t + 1;
    if (!active) { inst.status = 'stranded'; return false; }
    inst.active = active;
    inst.enteredAt = new Map([...active].map((p) => [p, inst.tick]));   // delayed transitions enabled next tick
    if (inst.status === 'stranded') inst.status = 'active';
    return true;
  }

  /** Route to a fixpoint (a unit). Returns the change-points passed through. */
  route(inst) {
    const hops = [];
    for (let c = this.acc(inst); c; c = this.acc(inst)) {
      hops.push(c);
      if (!this.migrate(inst, c)) break;
    }
    return hops;
  }

  /** One tick: route first (between ticks the instance is quiescent), then react. */
  tick(inst, present) {
    if (inst.status === 'finished') return;
    this.route(inst);
    if (inst.status !== 'active') return;
    react(this.versions.get(inst.version).chart, inst, present);
  }

  /**
   * What deploying `spec` would do, without changing anything: every instance routed with
   * the candidate added. migrate | stay | stranded, plus instances that may match later.
   */
  preview(spec) {
    const c = this.candidate(spec);
    const cp = { family: c.family, t: c.t, pattern: c.pattern, fp: c.fp, target: c.id, mapping: c.mapping };
    this._pending = { chart: c.chart };
    const out = { migrate: [], stay: [], stranded: [], lateMatchers: [], lateRisk: new Set() };
    try {
      for (const inst of this.instances.values()) {
        if (this.versions.get(inst.version).family !== c.family || inst.status === 'finished') continue;
        const copy = structuredClone(inst);
        const before = copy.version;
        let throughC = false;
        for (let h = this.acc(copy, cp); h; h = this.acc(copy, cp)) {
          if (h === cp) throughC = true;
          if (!this.migrate(copy, h)) break;
          if (h === cp) break;
        }
        const leaves = activeLeaves(this.versions.get(before).chart, inst);
        const row = { id: inst.id, version: before, leaves };
        if (copy.status === 'stranded' && inst.status !== 'stranded') out.stranded.push(row);
        else if (throughC) out.migrate.push(row);
        else out.stay.push(row);
        // late matchers: history is a proper prefix of the pattern → may match after more ticks
        if (c.pattern && !throughC && inst.history.length < c.pattern.length && inst.history.every((e, k) => e === c.pattern[k])) {
          out.lateMatchers.push(row);
          const chart = this.versions.get(before).chart;
          for (const leaf of [...chart.states.values()].filter((s) => !s.regions.length).map((s) => s.path)) {
            if (!this.placeLeafOk(chart, leaf, c.chart, c.mapping)) out.lateRisk.add(leaf);
          }
        }
      }
    } finally { this._pending = null; }
    out.lateRisk = [...out.lateRisk];
    return out;
  }

  /** Can a single leaf of `fromChart` be placed in `toChart` under `mapping`? */
  placeLeafOk(fromChart, leaf, toChart, mapping) {
    const keys = Object.keys(mapping).sort((a, b) => b.length - a.length);
    const k = keys.find((key) => leaf === key || leaf.startsWith(key + '.'));
    const p = k ? mapping[k] + leaf.slice(k.length) : leaf;
    return toChart.states.has(p) || (k && toChart.states.has(mapping[k]));
  }
}

