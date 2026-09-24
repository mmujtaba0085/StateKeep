/**
 * src/runtime/conditionGuards.js
 *
 * Built-in expression guards: a guard named `cond:<expression>` is evaluated directly,
 * no registry entry needed. Imported workflows (Step Functions Choice rules, SCXML
 * `cond`, BPMN gateway conditions) are mostly simple comparisons, so they run as-is.
 *
 *   cond:amount < 1000000
 *   cond:status == "approved" && !hasDefaults
 *   cond:event.score >= 700 || context.vip == true
 *
 * Grammar (no eval, no function calls, own-property access only):
 *   expr    := or
 *   or      := and ( '||' and )*
 *   and     := unary ( '&&' unary )*
 *   unary   := '!' unary | compare
 *   compare := operand ( ('=='|'!='|'<'|'<='|'>'|'>=') operand )?
 *   operand := number | string | true | false | null | path | '(' expr ')'
 *   path    := ident ('.' ident)*      — resolves against context unless it starts
 *                                         with `context.` or `event.`
 */

const TOKEN = /\s*(\|\||&&|==|!=|<=|>=|[<>!()]|-?\d+(?:\.\d+)?|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)/y;
const FORBIDDEN = new Set(['__proto__', 'prototype', 'constructor']);

function tokenize(src) {
  const out = [];
  TOKEN.lastIndex = 0;
  let pos = 0;
  while (pos < src.length) {
    if (/^\s*$/.test(src.slice(pos))) break;
    TOKEN.lastIndex = pos;
    const m = TOKEN.exec(src);
    if (!m) throw new Error(`cannot parse condition near "${src.slice(pos, pos + 12)}"`);
    out.push(m[1]);
    pos = TOKEN.lastIndex;
  }
  return out;
}

function parse(tokens) {
  let i = 0;
  const peek = () => tokens[i];
  const take = (t) => { if (tokens[i] !== t) throw new Error(`expected "${t}" but found "${tokens[i] ?? 'end'}"`); i++; };

  const operand = () => {
    const t = tokens[i++];
    if (t === undefined) throw new Error('unexpected end of condition');
    if (t === '(') { const e = or(); take(')'); return e; }
    if (/^-?\d/.test(t)) { const v = Number(t); return () => v; }
    if (t[0] === '"' || t[0] === "'") { const v = JSON.parse('"' + t.slice(1, -1).replace(/\\'/g, "'").replace(/"/g, '\\"') + '"'); return () => v; }
    if (t === 'true') return () => true;
    if (t === 'false') return () => false;
    if (t === 'null') return () => null;
    if (/^[A-Za-z_$]/.test(t)) {
      let parts = t.split('.');
      if (parts.some((p) => FORBIDDEN.has(p))) throw new Error(`path "${t}" is not allowed`);
      let root = 'context';
      if (parts[0] === 'context' || parts[0] === 'event') { root = parts[0]; parts = parts.slice(1); }
      return (scope) => parts.reduce((o, k) => (o != null && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined), scope[root]);
    }
    throw new Error(`unexpected "${t}"`);
  };
  const compare = () => {
    const left = operand();
    const op = peek();
    if (!['==', '!=', '<', '<=', '>', '>='].includes(op)) return left;
    i++;
    const right = operand();
    switch (op) {
      // null and a missing field compare equal (JSON has no `undefined`)
      case '==': return (s) => { const a = left(s), b = right(s); return (a == null && b == null) || a === b; };
      case '!=': return (s) => { const a = left(s), b = right(s); return !((a == null && b == null) || a === b); };
      case '<':  return (s) => left(s) <  right(s);
      case '<=': return (s) => left(s) <= right(s);
      case '>':  return (s) => left(s) >  right(s);
      default:   return (s) => left(s) >= right(s);
    }
  };
  const unary = () => { if (peek() === '!') { i++; const e = unary(); return (s) => !e(s); } return compare(); };
  const and = () => { let e = unary(); while (peek() === '&&') { i++; const l = e, r = unary(); e = (s) => l(s) && r(s); } return e; };
  const or  = () => { let e = and();   while (peek() === '||') { i++; const l = e, r = and();   e = (s) => l(s) || r(s); } return e; };

  const expr = or();
  if (i !== tokens.length) throw new Error(`unexpected "${tokens[i]}"`);
  return expr;
}

const cache = new Map();

/** Compile `cond:...` into a guard function ({context, event}) => boolean. Throws on bad syntax. */
export function compileCondition(expression) {
  if (cache.has(expression)) return cache.get(expression);
  const fn = parse(tokenize(expression));
  const guard = ({ context, event } = {}) => Boolean(fn({ context: context ?? {}, event: event ?? {} }));
  cache.set(expression, guard);
  return guard;
}

export const isConditionGuard = (name) => typeof name === 'string' && name.startsWith('cond:');

/** Returns a guard function for `cond:` names, or undefined (also for invalid expressions). */
export function conditionGuard(name) {
  if (!isConditionGuard(name)) return undefined;
  try { return compileCondition(name.slice(5)); } catch { return undefined; }
}

/** Registry whose guards also resolve `cond:` expressions (used where no user registry applies). */
export function withConditions(registry) {
  const base = registry ?? { guards: {}, actions: {}, services: {} };
  const guards = new Proxy(base.guards ?? {}, {
    get: (t, name) => (typeof name === 'string' && !(name in t)) ? conditionGuard(name) : t[name],
  });
  return { ...base, guards };
}
