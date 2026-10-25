/**
 * src/lib/testHooks.js — deterministic pause points for tests.
 *
 * Inert unless NODE_ENV=test and STATEKEEP_TEST_HOOK_DIR is set. A test arms a pause point
 * by creating `<dir>/<name>.arm`. The next time the server reaches testPausePoint(name), it
 * removes the arm file, creates `<dir>/<name>.paused`, and then FREEZES THE WHOLE PROCESS
 * (the event loop is blocked: no timers, heartbeats, syncs or other requests run), exactly
 * like SIGSTOP but at a known instruction, until the test creates `<dir>/<name>.release`.
 *
 * Used by test/cluster/cluster.test.js to pause a server at a precise point inside an
 * event unit while another server deploys.
 */
import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DIR = process.env.NODE_ENV === 'test' ? (process.env.STATEKEEP_TEST_HOOK_DIR || null) : null;
const sleeper = DIR ? new Int32Array(new SharedArrayBuffer(4)) : null;

export function testPausePoint(name) {
  if (!DIR) return;
  const arm = join(DIR, `${name}.arm`);
  if (!existsSync(arm)) return;
  try { unlinkSync(arm); } catch { return; }
  const paused = join(DIR, `${name}.paused`);
  const release = join(DIR, `${name}.release`);
  writeFileSync(paused, String(process.pid));
  while (!existsSync(release)) Atomics.wait(sleeper, 0, 0, 20);   // blocks the event loop
  try { unlinkSync(release); } catch {}
  try { unlinkSync(paused); } catch {}
}
