// src/runtime/implementationRegistry.js
//
// Loads guards/actions/services from a developer-provided setup object.
// Guards must be synchronous — detected by calling with dummy args.
// StateKeep.durable() and StateKeep.invoke() are factory utilities exported here.

export const StateKeep = {
  /**
   * Wrap an async function as a Tier 3 durable action.
   * The background action_jobs worker runs this with retry/backoff.
   */
  durable(fn, { maxRetries = 3, backoff = 'exponential', timeout = 30_000 } = {}) {
    const wrapped = (...args) => fn(...args);
    wrapped.__sk_durable = { maxRetries, backoff, timeout, originalFn: fn };
    return wrapped;
  },

  /**
   * Wrap an async function as an invoke service with idempotency declaration.
   */
  invoke(fn, { idempotent = false, timeout = 30_000 } = {}) {
    const wrapped = (...args) => fn(...args);
    wrapped.__sk_invoke = { idempotent, timeout, originalFn: fn };
    return wrapped;
  },
};

/**
 * Load and validate a setup object into a registry.
 * Throws if any guard is async (detected by calling with dummy args).
 */
export function loadRegistry({ guards = {}, actions = {}, services = {} } = {}) {
  // Validate guards are synchronous
  for (const [name, fn] of Object.entries(guards)) {
    if (typeof fn !== 'function') throw new Error(`Guard '${name}' must be a function`);
    let result;
    try { result = fn({ context: {}, event: {} }, {}); } catch { result = false; }
    if (result && typeof result.then === 'function') {
      throw new Error(`Guard '${name}' must be synchronous but returns a Promise. Guards cannot be async.`);
    }
  }
  return { guards, actions, services };
}

/**
 * Check that every guard/action/service name in compiledJson exists in registry.
 * Returns array of missing names (empty = valid).
 */
export function validateDefinitionAgainstRegistry(compiledJson, registry) {
  const missing = new Set();

  function checkAction(name) {
    if (name && !registry.actions[name]) missing.add(name);
  }
  function checkGuard(name) {
    if (name && !registry.guards[name]) missing.add(name);
  }

  for (const candidates of Object.values(compiledJson.transitions ?? {})) {
    for (const c of candidates) {
      checkGuard(c.guard);
      (c.actions ?? []).forEach(checkAction);
    }
  }
  for (const c of Object.values(compiledJson.transientStates ?? {})) {
    (Array.isArray(c) ? c : [c]).forEach(x => checkGuard(x.guard));
  }
  for (const acts of Object.values(compiledJson.entryActions ?? {})) {
    acts.forEach(checkAction);
  }
  for (const acts of Object.values(compiledJson.exitActions ?? {})) {
    acts.forEach(checkAction);
  }
  return [...missing];
}

// Global registry singleton (set by server startup or createStateKeep)
let _registry = null;

export function setGlobalRegistry(reg) { _registry = reg; }
export function getGlobalRegistry()    { return _registry; }
