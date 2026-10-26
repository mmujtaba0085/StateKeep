/**
 * sctx.js — a parser for a subset of the SCCharts textual syntax (.sctx, KIELER).
 *
 * Supported:
 *   scchart Name { … }
 *   input bool A, B   |  input signal A  |  output bool O = false   (bool / pure signals)
 *   [initial] [final] state Name [{ … }]
 *   region Name { … }  |  region Name:   (concurrent regions inside a superstate; a
 *                                         superstate without `region` has one implicit region)
 *   [immediate] [if <expr>] [do <effects>] (go | abort | join) to Target
 *   entry do <effects>  |  during do <effects>  |  exit do <effects>
 *   <expr>    := identifiers, !, &&, ||, parentheses, true, false
 *   <effects> := Out = true | Out = false | Out   (an output; `Out` alone emits a signal)
 *   // and /* … *\/ comments
 *
 * Not supported (reported as an error): valued variables, pre(), count delays, history
 * transitions, suspend, references to other charts, `for` regions, host code.
 *
 * Result: { name, inputs, outputs, root } where every state is
 *   { name, path, initial, final, regions: [{ name, path, states }], transitions, entry, during, exit }
 * and a transition is { id, source, target, kind: 'go'|'abort'|'join', immediate, trigger, effects }.
 * `trigger` is a predicate over the set of present inputs; `triggerText` keeps its source.
 */

const KEYWORDS = new Set(['scchart', 'input', 'output', 'bool', 'signal', 'initial', 'final', 'state',
  'region', 'immediate', 'if', 'do', 'go', 'abort', 'join', 'to', 'entry', 'during', 'exit', 'true', 'false']);
const UNSUPPORTED = ['pre', 'suspend', 'history', 'shallow', 'deferred', 'is', 'import', 'for', 'int', 'float', 'string', 'host', 'const', 'combine', 'weak', 'strong', 'connector'];

function tokenize(src) {
  const toks = [];
  const re = /\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/|(&&|\|\||[{}():,;=!])|([A-Za-z_][A-Za-z0-9_]*)|(\d+)|(.)/gy;
  let m, line = 1;
  while ((m = re.exec(src)) !== null) {
    const text = m[0];
    if (m[1]) toks.push({ t: m[1], line });
    else if (m[2]) toks.push({ t: m[2], line, id: true });
    else if (m[3]) toks.push({ t: m[3], line, num: true });
    else if (m[4]) throw new Error(`line ${line}: unexpected character "${m[4]}"`);
    line += (text.match(/\n/g) ?? []).length;
    if (re.lastIndex >= src.length) break;
  }
  return toks;
}

export function parseSctx(src) {
  const toks = tokenize(src);
  let i = 0;
  const peek = (k = 0) => toks[i + k]?.t;
  const line = () => toks[Math.min(i, toks.length - 1)]?.line ?? 0;
  const fail = (msg) => { throw new Error(`line ${line()}: ${msg}`); };
  const next = () => { if (i >= toks.length) fail('unexpected end of input'); return toks[i++].t; };
  const expect = (t) => { const x = next(); if (x !== t) fail(`expected "${t}", found "${x}"`); return x; };
  const ident = () => {
    const tok = toks[i];
    if (!tok?.id || KEYWORDS.has(tok.t)) fail(`expected a name, found "${tok?.t}"`);
    if (UNSUPPORTED.includes(tok.t)) fail(`"${tok.t}" is not supported by this prototype`);
    i++; return tok.t;
  };
  const accept = (t) => (peek() === t ? (i++, true) : false);

  const inputs = new Set(), outputs = new Map();

  expect('scchart');
  const name = ident();
  expect('{');

  // ── expressions ────────────────────────────────────────────────────────────
  function expr() {                       // or
    let l = conj();
    while (accept('||')) { const a = l, b = conj(); l = { op: '||', a, b }; }
    return l;
  }
  function conj() {
    let l = unary();
    while (accept('&&')) { const a = l, b = unary(); l = { op: '&&', a, b }; }
    return l;
  }
  function unary() {
    if (accept('!')) return { op: '!', a: unary() };
    if (accept('(')) { const e = expr(); expect(')'); return e; }
    if (accept('true')) return { op: 'const', v: true };
    if (accept('false')) return { op: 'const', v: false };
    if (UNSUPPORTED.includes(peek())) fail(`"${peek()}" is not supported by this prototype`);
    const n = ident();
    if (!inputs.has(n) && !outputs.has(n)) fail(`unknown signal "${n}" in trigger`);
    return { op: 'var', n };
  }
  const show = (e) => e.op === 'var' ? e.n : e.op === 'const' ? String(e.v) : e.op === '!' ? `!${show(e.a)}`
    : `(${show(e.a)} ${e.op} ${show(e.b)})`;
  const compile = (e) => e.op === 'var' ? (p) => p.has(e.n) : e.op === 'const' ? () => e.v
    : e.op === '!' ? ((f) => (p) => !f(p))(compile(e.a))
      : e.op === '&&' ? ((f, g) => (p) => f(p) && g(p))(compile(e.a), compile(e.b))
        : ((f, g) => (p) => f(p) || g(p))(compile(e.a), compile(e.b));

  function effects() {
    const out = [];
    do {
      const n = ident();
      if (!outputs.has(n)) fail(`"${n}" is not an output`);
      if (accept('=')) {
        if (accept('true')) out.push({ out: n, v: true });
        else if (accept('false')) out.push({ out: n, v: false });
        else fail('only "= true" / "= false" are supported in effects');
      } else out.push({ out: n, v: true });            // emit a pure signal
    } while (accept(';'));
    return out;
  }

  // ── declarations ──────────────────────────────────────────────────────────
  while (peek() === 'input' || peek() === 'output') {
    const dir = next();
    const ty = next();
    if (ty !== 'bool' && ty !== 'signal') fail(`type "${ty}" is not supported (bool or signal only)`);
    do {
      const n = ident();
      let init = false;
      if (accept('=')) { if (accept('true')) init = true; else expect('false'); }
      if (dir === 'input') inputs.add(n); else outputs.set(n, { type: ty, init });
    } while (accept(','));
  }

  // ── states and regions ─────────────────────────────────────────────────────
  function stateList(parentPath, closing) {
    const states = [];
    const pending = [];                                 // transitions resolved after the scope is read
    while (peek() !== closing && peek() !== 'region' && i < toks.length) {
      states.push(state(parentPath, pending));
    }
    const byName = new Map(states.map((s) => [s.name, s]));
    for (const { tr, targetName } of pending) {
      const tgt = byName.get(targetName);
      if (!tgt) throw new Error(`transition ${tr.source} → ${targetName}: no state "${targetName}" in the same region`);
      tr.target = tgt.path;
    }
    const initials = states.filter((s) => s.initial);
    if (states.length && initials.length !== 1) throw new Error(`region ${parentPath || name}: needs exactly one initial state (has ${initials.length})`);
    return states;
  }

  function state(parentPath, pending) {
    let initial = false, final = false;
    for (;;) { if (accept('initial')) initial = true; else if (accept('final')) final = true; else break; }
    if (!accept('state')) fail(`expected "state", found "${peek()}"`);
    const n = ident();
    const path = parentPath ? `${parentPath}.${n}` : n;
    const s = { name: n, path, initial, final, regions: [], transitions: [], entry: [], during: [], exit: [] };
    if (accept('{')) {
      // actions first, then states or regions
      for (;;) {
        if (peek() === 'entry' || peek() === 'during' || peek() === 'exit') {
          const kind = next(); expect('do'); s[kind].push(...effects());
        } else break;
      }
      if (peek() === 'region') {
        while (accept('region')) {
          const rn = ident();
          const rpath = `${path}.${rn}`;
          if (accept('{')) { s.regions.push({ name: rn, path: rpath, states: stateList(rpath, '}') }); expect('}'); }
          else { expect(':'); s.regions.push({ name: rn, path: rpath, states: stateList(rpath, '}') }); }
        }
      } else if (peek() !== '}') {
        s.regions.push({ name: '_', path, states: stateList(path, '}') });   // implicit single region
      }
      expect('}');
    }
    // outgoing transitions of this state
    let k = 0;
    while (['immediate', 'if', 'do', 'go', 'abort', 'join'].includes(peek())) {
      const immediate = accept('immediate');
      let trigger = () => true, triggerText = '';
      if (accept('if')) { const e = expr(); trigger = compile(e); triggerText = show(e); }
      const eff = accept('do') ? effects() : [];
      const kind = next();
      if (!['go', 'abort', 'join'].includes(kind)) fail(`expected go/abort/join, found "${kind}"`);
      expect('to');
      const targetName = ident();
      if (kind === 'join' && !s.regions.length) fail(`join transition from simple state ${n}`);
      const tr = { id: null, source: path, target: null, kind, immediate, trigger, triggerText, effects: eff, prio: k++ };
      s.transitions.push(tr);
      pending.push({ tr, targetName });
    }
    return s;
  }

  const rootStates = stateList('', '}');
  expect('}');
  if (i !== toks.length) fail(`unexpected "${peek()}" after the chart`);

  const root = { name, path: '', initial: true, final: false, regions: [{ name: '_', path: '', states: rootStates }], transitions: [], entry: [], during: [], exit: [] };
  // Transition ids: "Source->Target", with "#n" when a state has two transitions to one target.
  const all = [];
  const visit = (s) => { all.push(s); for (const r of s.regions) for (const c of r.states) visit(c); };
  visit(root);
  for (const s of all) {
    const seen = new Map();
    for (const t of s.transitions) {
      const base = `${t.source}->${t.target}`;
      const n = (seen.get(base) ?? 0) + 1; seen.set(base, n);
      t.id = n === 1 ? base : `${base}#${n}`;
    }
  }
  const states = new Map(all.filter((s) => s !== root).map((s) => [s.path, s]));
  return { name, inputs: [...inputs], outputs: Object.fromEntries(outputs), root, states };
}

/** Every leaf state path (no regions) of a chart, for placement checks. */
export function leafPaths(chart) {
  return [...chart.states.values()].filter((s) => s.regions.length === 0).map((s) => s.path);
}
