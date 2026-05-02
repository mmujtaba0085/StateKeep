const path = require('path');
const fs = require('fs');
const MockStateKeep = require('./statekeepHelper');

const TMP_PERSIST = path.join(__dirname, '..', '..', 'test-results', 'statekeep-runtime.json');

describe('StateKeep runtime & maroon detection (mock)', () => {
  let mock;

  beforeAll(() => {
    const tr = path.join(__dirname, '..', '..', 'test-results');
    if (!fs.existsSync(tr)) fs.mkdirSync(tr, { recursive: true });
  });

  beforeEach(async () => {
    mock = new MockStateKeep({ persistFile: TMP_PERSIST });
    await mock.start();
  });

  afterEach(async () => {
    await mock.stop();
    if (fs.existsSync(TMP_PERSIST)) fs.unlinkSync(TMP_PERSIST);
  });

  test('per-actor migration decisions on code change (fingerprint mismatch)', async () => {
    // actor A has history [X, Y]
    await mock.sendEvent({ actorId: 'actor-A', type: 'X' });
    await mock.sendEvent({ actorId: 'actor-A', type: 'Y' });

    // actor B has history [X]
    await mock.sendEvent({ actorId: 'actor-B', type: 'X' });

    // compute fingerprint of actor-A
    const fpRes = await fetch(`${mock.url()}/fingerprint/actor-A`);
    const { fingerprint } = await fpRes.json();

    // Deploy new version with expectedFingerprint = fingerprint (so actor-A should NOT migrate)
    const migrateA = await fetch(`${mock.url()}/migrate`, {
      method: 'POST',
      body: JSON.stringify({ actorId: 'actor-A', newVersion: 'v2', expectedFingerprint: fingerprint }),
      headers: { 'content-type': 'application/json' },
    });
    const ra = await migrateA.json();
    expect(ra.migrated).toBe(false);

    // Deploy same expectedFingerprint for actor-B: since fp differs, actor-B should migrate
    const migrateB = await fetch(`${mock.url()}/migrate`, {
      method: 'POST',
      body: JSON.stringify({ actorId: 'actor-B', newVersion: 'v2', expectedFingerprint: fingerprint }),
      headers: { 'content-type': 'application/json' },
    });
    const rb = await migrateB.json();
    expect(rb.migrated).toBe(true);
  });

  test('marooned actors are reported (history present, no state)', async () => {
    await mock.sendEvent({ actorId: 'maroon-1', type: 'EV' });
    await mock.sendEvent({ actorId: 'ok-1', type: 'EV' });

    // set state for ok-1 so it's not marooned
    await fetch(`${mock.url()}/setstate`, {
      method: 'POST',
      body: JSON.stringify({ actorId: 'ok-1', state: 'running' }),
      headers: { 'content-type': 'application/json' },
    });

    const r = await fetch(`${mock.url()}/report/marooned`);
    const body = await r.json();
    expect(body.marooned).toContain('maroon-1');
    expect(body.marooned).not.toContain('ok-1');
  });
});
