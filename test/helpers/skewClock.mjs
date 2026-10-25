/**
 * test/helpers/skewClock.mjs — run a process on a skewed clock (tests only).
 *
 *   node --import ./test/helpers/skewClock.mjs src/api/server.js
 *
 *   SK_CLOCK_OFFSET_MS  wall clock offset (Date.now, new Date()), e.g. -300000
 *   SK_CLOCK_RATE       clock rate: 0.5 = this process's time runs at half speed (its
 *                       Date.now/performance.now advance half as fast, and its timers
 *                       fire twice as late); 2 = double speed
 *
 * Both what the process reads (wall clock and monotonic clock) and how long its timers
 * take are skewed, consistently, like a machine with a wrong and drifting clock.
 * libfaketime does not reliably affect Node's monotonic timers, hence this preload.
 */
const OFFSET = Number(process.env.SK_CLOCK_OFFSET_MS ?? 0);
const RATE   = Number(process.env.SK_CLOCK_RATE ?? 1);

if (OFFSET !== 0 || RATE !== 1) {
  const realNow  = Date.now.bind(Date);
  const realPerf = performance.now.bind(performance);
  const wall0 = realNow(), perf0 = realPerf();
  const skewedNow  = () => Math.floor(wall0 + OFFSET + (realNow() - wall0) * RATE);
  const skewedPerf = () => perf0 + (realPerf() - perf0) * RATE;

  const RealDate = Date;
  class SkewedDate extends RealDate {
    constructor(...args) { if (args.length === 0) super(skewedNow()); else super(...args); }
    static now() { return skewedNow(); }
  }
  globalThis.Date = SkewedDate;
  performance.now = skewedPerf;

  const scale = (ms) => (typeof ms === 'number' && ms > 0 ? ms / RATE : ms);
  const st = globalThis.setTimeout, si = globalThis.setInterval;
  globalThis.setTimeout  = (fn, ms, ...a) => st(fn, scale(ms), ...a);
  globalThis.setInterval = (fn, ms, ...a) => si(fn, scale(ms), ...a);

  // timers/promises (e.g. `await setTimeout(…)` from 'node:timers/promises')
  const tp = await import('node:timers/promises');
  const pst = tp.setTimeout;
  try { Object.defineProperty(tp, 'setTimeout', { value: (ms, ...a) => pst(scale(ms), ...a) }); } catch {}

  process.stderr.write(`[skewClock] offset ${OFFSET} ms, rate ${RATE}\n`);
}
