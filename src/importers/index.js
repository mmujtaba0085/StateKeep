/**
 * src/importers/index.js
 *
 * Convert workflows written for other engines into StateKeep definitions, so teams on
 * AWS Step Functions, SCXML tools or BPMN (Camunda, Flowable, …) can bring their
 * long-running processes — and get history-based version migration for them.
 *
 *   importDefinition('asl' | 'scxml' | 'bpmn', source, { id }) → { definition, warnings }
 *
 * Conventions shared by all importers
 *   - A "work" step (ASL Task, BPMN task, …) becomes a state that runs an entry action
 *     named after the step's resource/implementation, then waits for `DONE`
 *     (success) or `FAILED` (error). The action can be local JS or a remote
 *     implementation (docs/remote-implementations.md) that replies { send: { type: 'DONE' } }.
 *   - Conditions become built-in `cond:` guards when they are simple comparisons;
 *     otherwise a named guard is generated and listed in `warnings` to implement.
 *   - Anything not representable is reported in `warnings`, never silently dropped.
 */

import { XMLParser } from 'fast-xml-parser';
import { compileCondition } from '../runtime/conditionGuards.js';

const safeKey  = (s) => String(s).trim().replace(/[.\s#]+/g, '_').replace(/[^\w$-]/g, '') || 'state';
const safeName = (s) => String(s).trim().replace(/[^\w$-]+/g, '_').replace(/^_+|_+$/g, '') || 'action';

function asCondition(expr, fallbackName, warnings, where) {
  const e = String(expr ?? '').trim();
  try { compileCondition(e); return `cond:${e}`; } catch (err) {
    warnings.push({ type: 'UNSUPPORTED_CONDITION', at: where, message: `condition "${e}" is not a simple comparison (${err.message}); implement guard '${fallbackName}'` });
    return fallbackName;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// AWS Step Functions (Amazon States Language)
// ═══════════════════════════════════════════════════════════════════════════
const ASL_OPS = {
  StringEquals: '==', NumericEquals: '==', BooleanEquals: '==', TimestampEquals: '==',
  NumericLessThan: '<', NumericLessThanEquals: '<=', NumericGreaterThan: '>', NumericGreaterThanEquals: '>=',
  StringLessThan: '<', StringLessThanEquals: '<=', StringGreaterThan: '>', StringGreaterThanEquals: '>=',
};
const aslPath = (p) => {
  if (typeof p !== 'string' || !p.startsWith('$.')) throw new Error(`path "${p}" (only $.field paths are supported)`);
  return p.slice(2);
};
function aslRule(rule) {
  if (rule.And) return '(' + rule.And.map(aslRule).join(' && ') + ')';
  if (rule.Or)  return '(' + rule.Or.map(aslRule).join(' || ') + ')';
  if (rule.Not) return '!(' + aslRule(rule.Not) + ')';
  const v = aslPath(rule.Variable);
  if ('IsNull' in rule)    return rule.IsNull ? `${v} == null` : `${v} != null`;
  if ('IsPresent' in rule) return rule.IsPresent ? `${v} != null` : `${v} == null`;
  for (const [op, sym] of Object.entries(ASL_OPS)) {
    if (op in rule)          return `${v} ${sym} ${JSON.stringify(rule[op])}`;
    if (`${op}Path` in rule) return `${v} ${sym} ${aslPath(rule[`${op}Path`])}`;
  }
  throw new Error(`operator ${Object.keys(rule).filter((k) => k !== 'Variable' && k !== 'Next').join(',')}`);
}

export function importASL(source, { id } = {}) {
  const asl = typeof source === 'string' ? JSON.parse(source) : source;
  if (!asl?.StartAt || !asl?.States) throw new Error('not an Amazon States Language document (StartAt/States missing)');
  const warnings = [];
  const keyOf = (name) => safeKey(name);
  const states = {};
  let needsEnd = false;
  const next = (s) => { if (s.End) { needsEnd = true; return '__end'; } return keyOf(s.Next); };

  for (const [name, s] of Object.entries(asl.States)) {
    const key = keyOf(name);
    const at  = `States.${name}`;
    switch (s.Type) {
      case 'Task':
      case 'Parallel':
      case 'Map': {
        if (s.Type !== 'Task') warnings.push({ type: 'SIMPLIFIED', at, message: `${s.Type} runs as a single step: its action must report DONE when all branches finish` });
        const res = s.Type === 'Task' ? String(s.Resource ?? name).split(':').pop() : name;
        const action = safeName(res);
        const onFail = s.Catch?.[0]?.Next ? keyOf(s.Catch[0].Next) : '__failed';
        if (!s.Catch?.length) states.__failed = { type: 'final' };
        if (s.Retry) warnings.push({ type: 'IGNORED', at, message: 'Retry: durable actions already retry with exponential backoff' });
        states[key] = { entry: [action], on: { DONE: next(s), FAILED: onFail } };
        break;
      }
      case 'Pass':
        if (s.Result !== undefined || s.Parameters) warnings.push({ type: 'IGNORED', at, message: 'Pass Result/Parameters are not applied' });
        states[key] = { always: next(s) };
        break;
      case 'Choice': {
        const always = (s.Choices ?? []).map((rule, i) => {
          const fallback = `choice_${safeName(name)}_${i}`;
          let guard;
          try { guard = asCondition(aslRule(rule), fallback, warnings, at); }
          catch (err) { warnings.push({ type: 'UNSUPPORTED_CONDITION', at, message: `${err.message}; implement guard '${fallback}'` }); guard = fallback; }
          return { target: keyOf(rule.Next), guard };
        });
        if (s.Default) always.push({ target: keyOf(s.Default) });
        else warnings.push({ type: 'NO_DEFAULT', at, message: 'Choice without Default: actor stays here if no rule matches' });
        states[key] = { always };
        break;
      }
      case 'Wait':
        if (typeof s.Seconds === 'number') states[key] = { after: { [s.Seconds * 1000]: next(s) } };
        else {
          warnings.push({ type: 'SIMPLIFIED', at, message: 'Wait with Timestamp/SecondsPath: send WAIT_DONE when the time is reached' });
          states[key] = { on: { WAIT_DONE: next(s) } };
        }
        break;
      case 'Succeed': states[key] = { type: 'final' }; break;
      case 'Fail':    states[key] = { type: 'final' }; break;
      default:
        warnings.push({ type: 'UNSUPPORTED', at, message: `state type ${s.Type}` });
        states[key] = { on: { DONE: s.Next ? keyOf(s.Next) : '__end' } };
        if (!s.Next) needsEnd = true;
    }
  }
  if (needsEnd) states.__end = { type: 'final' };
  return { definition: { id: id ?? safeKey(asl.Comment ?? 'imported_asl'), initial: keyOf(asl.StartAt), states }, warnings };
}

// ═══════════════════════════════════════════════════════════════════════════
// XML helpers (document order matters: SCXML's default initial = first child)
// ═══════════════════════════════════════════════════════════════════════════
function parseXml(source) {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '', preserveOrder: true, trimValues: true });
  const toNodes = (arr) => (arr ?? []).flatMap((o) => {
    const tag = Object.keys(o).find((k) => k !== ':@');
    if (!tag) return [];
    if (tag === '#text') return [{ tag: '#text', text: String(o['#text']), attrs: {}, children: [] }];
    const local = tag.includes(':') ? tag.split(':').pop() : tag;
    return [{ tag: local, attrs: o[':@'] ?? {}, children: toNodes(o[tag]) }];
  });
  return toNodes(parser.parse(source));
}
const kids = (n, ...tags) => n.children.filter((c) => tags.includes(c.tag));
const textOf = (n) => n.children.filter((c) => c.tag === '#text').map((c) => c.text).join('').trim();

// ═══════════════════════════════════════════════════════════════════════════
// SCXML (W3C State Chart XML)
// ═══════════════════════════════════════════════════════════════════════════
export function importSCXML(source, { id } = {}) {
  const root = parseXml(source).find((n) => n.tag === 'scxml');
  if (!root) throw new Error('not an SCXML document (<scxml> root missing)');
  const warnings = [];
  const machineId = id ?? safeKey(root.attrs.name ?? 'imported_scxml');

  // Pass 1: global id → absolute path
  const paths = new Map();
  let auto = 0;
  const walk = (node, prefix) => {
    for (const c of kids(node, 'state', 'parallel', 'final')) {
      const key = safeKey(c.attrs.id ?? `s${auto++}`);
      c.attrs.id = c.attrs.id ?? key;
      const path = prefix ? `${prefix}.${key}` : key;
      paths.set(c.attrs.id, path);
      walk(c, path);
    }
  };
  walk(root, '');
  const target = (ids, at) => {
    const first = String(ids ?? '').trim().split(/\s+/)[0];
    if (!first) return undefined;
    if (!paths.has(first)) { warnings.push({ type: 'UNKNOWN_TARGET', at, message: `target "${first}"` }); return undefined; }
    return `#${machineId}.${paths.get(first)}`;
  };
  const cond = (c, at, i) => c ? asCondition(String(c).replace(/_event\.data\./g, 'event.').replace(/===/g, '==').replace(/!==/g, '!='), `scxml_${safeName(at)}_${i}`, warnings, at) : undefined;

  // Pass 2: build states
  const build = (node) => {
    const out = {};
    const at = node.attrs.id;
    if (node.tag === 'final') return { type: 'final' };
    if (node.tag === 'parallel') out.type = 'parallel';
    for (const tag of ['onentry', 'onexit', 'invoke', 'datamodel']) {
      if (kids(node, tag).length) warnings.push({ type: 'IGNORED', at, message: `<${tag}> is not imported (use entry/exit actions)` });
    }
    const on = {}, always = [];
    kids(node, 'transition').forEach((t, i) => {
      const cand = { target: target(t.attrs.target, at) };
      const g = cond(t.attrs.cond, at, i);
      if (g) cand.guard = g;
      const events = String(t.attrs.event ?? '').trim().split(/\s+/).filter(Boolean);
      if (events.length === 0) always.push(cand);
      for (const e of events) (on[e] = on[e] ?? []).push(cand);
    });
    const simplify = (arr) => arr.length === 1 && !arr[0].guard ? arr[0].target : arr;
    if (Object.keys(on).length) out.on = Object.fromEntries(Object.entries(on).map(([k, v]) => [k, simplify(v)]));
    if (always.length) out.always = simplify(always);
    const children = kids(node, 'state', 'parallel', 'final');
    if (children.length) {
      out.states = Object.fromEntries(children.map((c) => [safeKey(c.attrs.id), build(c)]));
      if (node.tag !== 'parallel') {
        const initEl = kids(node, 'initial')[0];
        const initId = node.attrs.initial ?? (initEl ? kids(initEl, 'transition')[0]?.attrs.target : null) ?? children[0].attrs.id;
        out.initial = safeKey(String(initId).split(/\s+/)[0]);
      }
    }
    return out;
  };
  const top = kids(root, 'state', 'parallel', 'final');
  const initial = safeKey(root.attrs.initial ?? top[0]?.attrs.id);
  const definition = { id: machineId, initial, states: Object.fromEntries(top.map((c) => [safeKey(c.attrs.id), build(c)])) };
  return { definition, warnings };
}

// ═══════════════════════════════════════════════════════════════════════════
// BPMN 2.0 (process subset: tasks, exclusive gateways, timers, messages, end)
// ═══════════════════════════════════════════════════════════════════════════
const isoMs = (d) => {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(String(d).trim());
  if (!m) return null;
  return (((+(m[1] ?? 0) * 24 + +(m[2] ?? 0)) * 60 + +(m[3] ?? 0)) * 60 + +(m[4] ?? 0)) * 1000;
};

export function importBPMN(source, { id } = {}) {
  const nodes = parseXml(source);
  const defs = nodes.find((n) => n.tag === 'definitions');
  const proc = defs && kids(defs, 'process')[0];
  if (!proc) throw new Error('no <bpmn:process> found');
  const warnings = [];
  const messages = new Map(kids(defs, 'message').map((m) => [m.attrs.id, m.attrs.name ?? m.attrs.id]));
  const flows = kids(proc, 'sequenceFlow').map((f) => ({
    id: f.attrs.id, from: f.attrs.sourceRef, to: f.attrs.targetRef,
    cond: kids(f, 'conditionExpression')[0] ? textOf(kids(f, 'conditionExpression')[0]).replace(/^\$\{|\}$/g, '').trim() : null,
  }));
  const out = (nid) => flows.filter((f) => f.from === nid);
  const key = (nid) => safeKey(nid);
  const TASKS = ['task', 'userTask', 'serviceTask', 'scriptTask', 'manualTask', 'sendTask', 'businessRuleTask', 'receiveTask', 'callActivity', 'subProcess'];
  const states = {};
  let initial = null;

  const guarded = (nid, at, defaultFlow) => out(nid).map((f, i) => {
    const cand = { target: key(f.to) };
    if (f.cond && f.id !== defaultFlow) cand.guard = asCondition(f.cond, `bpmn_${safeName(f.id ?? `${nid}_${i}`)}`, warnings, at);
    return cand;
  }).sort((a, b) => (a.guard ? 0 : 1) - (b.guard ? 0 : 1));   // unconditional/default last
  const single = (arr) => arr.length === 1 && !arr[0].guard ? arr[0].target : arr;

  for (const n of proc.children) {
    const nid = n.attrs.id; if (!nid) continue;
    const at = `${n.tag}#${nid}`;
    if (n.tag === 'startEvent') { initial = out(nid)[0] ? key(out(nid)[0].to) : null; continue; }
    if (n.tag === 'endEvent') { states[key(nid)] = { type: 'final' }; continue; }
    if (TASKS.includes(n.tag)) {
      if (['callActivity', 'subProcess'].includes(n.tag)) warnings.push({ type: 'SIMPLIFIED', at, message: `${n.tag} runs as one step: report DONE when it finishes` });
      const st = {};
      const next = single(guarded(nid, at, null));
      if (n.tag === 'receiveTask') {
        const msg = messages.get(n.attrs.messageRef) ?? 'MESSAGE';
        st.on = { [msg]: next };
      } else {
        const automatic = ['serviceTask', 'scriptTask', 'sendTask', 'businessRuleTask'].includes(n.tag);
        if (automatic) {
          const impl = n.attrs.type ?? n.attrs['camunda:type'] ?? n.attrs.implementation ?? n.attrs.delegateExpression ?? n.attrs.name ?? nid;
          st.entry = [safeName(String(impl).replace(/^\$\{|\}$/g, '').replace(/^##/, '') || nid)];
        }
        st.on = { DONE: next };
      }
      states[key(nid)] = st;
      continue;
    }
    if (n.tag === 'exclusiveGateway' || n.tag === 'inclusiveGateway') {
      if (n.tag === 'inclusiveGateway') warnings.push({ type: 'SIMPLIFIED', at, message: 'inclusive gateway treated as exclusive (first matching flow)' });
      states[key(nid)] = { always: guarded(nid, at, n.attrs.default) };
      continue;
    }
    if (n.tag === 'parallelGateway') {
      warnings.push({ type: 'UNSUPPORTED', at, message: 'parallel gateway: branches are followed one at a time (first outgoing flow)' });
      states[key(nid)] = { always: out(nid)[0] ? key(out(nid)[0].to) : undefined };
      continue;
    }
    if (n.tag === 'intermediateCatchEvent' || n.tag === 'boundaryEvent') {
      if (n.tag === 'boundaryEvent') { warnings.push({ type: 'UNSUPPORTED', at, message: 'boundary events are not imported' }); continue; }
      const timer = kids(n, 'timerEventDefinition')[0];
      const msg   = kids(n, 'messageEventDefinition')[0];
      const next  = single(guarded(nid, at, null));
      if (timer) {
        const dur = kids(timer, 'timeDuration')[0];
        const ms  = dur ? isoMs(textOf(dur)) : null;
        if (ms != null) states[key(nid)] = { after: { [ms]: next } };
        else { warnings.push({ type: 'SIMPLIFIED', at, message: 'timer without ISO duration: send TIMER_FIRED' }); states[key(nid)] = { on: { TIMER_FIRED: next } }; }
      } else if (msg) {
        states[key(nid)] = { on: { [messages.get(msg.attrs.messageRef) ?? 'MESSAGE']: next } };
      } else {
        warnings.push({ type: 'UNSUPPORTED', at, message: 'catch event type' });
        states[key(nid)] = { on: { DONE: next } };
      }
      continue;
    }
    if (['sequenceFlow', 'laneSet', 'extensionElements', 'documentation', '#text'].includes(n.tag)) continue;
    warnings.push({ type: 'IGNORED', at, message: `element <${n.tag}>` });
  }
  if (!initial) throw new Error('process has no startEvent with an outgoing flow');
  return { definition: { id: id ?? safeKey(proc.attrs.name ?? proc.attrs.id ?? 'imported_bpmn'), initial, states }, warnings };
}

export function importDefinition(format, source, opts = {}) {
  switch (String(format).toLowerCase()) {
    case 'asl': case 'stepfunctions': case 'step-functions': return importASL(source, opts);
    case 'scxml': return importSCXML(source, opts);
    case 'bpmn':  return importBPMN(source, opts);
    default: throw new Error(`unknown format "${format}" (use asl, scxml or bpmn)`);
  }
}

/** Guess the format from the source text. */
export function detectFormat(source) {
  const s = String(source).trimStart();
  if (s.startsWith('{')) return 'asl';
  if (/<(\w+:)?scxml[\s>]/.test(s)) return 'scxml';
  if (/<(\w+:)?definitions[\s>]/.test(s) && /bpmn/i.test(s)) return 'bpmn';
  throw new Error('cannot detect format — pass format explicitly');
}
