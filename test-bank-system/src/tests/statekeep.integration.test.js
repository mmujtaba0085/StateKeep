const path = require('path');
const fs = require('fs');
const MockStateKeep = require('./statekeepHelper');
const transactionService = require('../../src/services/transactionService');
const accountService = require('../../src/services/accountService');

const TMP_PERSIST = path.join(__dirname, '..', '..', 'test-results', 'statekeep-persist.json');

describe('StateKeep integration (mock)', () => {
  let mock;

  beforeAll(async () => {
    // ensure test-results directory
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

  test('events are sent without changing business logic', async () => {
    // wrap transactionService.initiateTransaction to forward an event to StateKeep
    const orig = transactionService.initiateTransaction;
    transactionService.initiateTransaction = async function (payload) {
      const res = await orig.apply(this, arguments);
      // best-effort: if result contains transaction id, send an event
      const actorId = payload.sourceAccount || payload.accountId || (res && res.sourceAccount) || (res && res.accountId) || 'acct-test';
      await mock.sendEvent({ actorId, type: 'TRANSACTION_INITIATED', payload, timestamp: Date.now() });
      return res;
    };

    // call business logic and capture returned transaction id
    const result = await transactionService.initiateTransaction({ sourceAccount: 'acct-1', amount: 42 });
    const txId = result.id;

    // assert business logic result exists in service store
    const stored = await transactionService.getTransaction(txId);
    expect(stored).toBeDefined();

    // assert mock received an event
    const events = mock.getStore().events;
    expect(events.length).toBeGreaterThan(0);

    // restore
    transactionService.initiateTransaction = orig;
  });

  test('StateKeep persists and restores state', async () => {
    // send events for an actor and persist
    await mock.sendEvent({ actorId: 'acct-persist', type: 'CREATE', payload: { bal: 1 } });
    await mock.sendEvent({ actorId: 'acct-persist', type: 'DEPOSIT', payload: { amount: 9 } });
    // persist to file
    mock.persistTo(TMP_PERSIST);
    await mock.stop();

    // load new instance from file and start
    const loaded = MockStateKeep.loadFrom(TMP_PERSIST);
    await loaded.start();
    const res = await fetch(`${loaded.url()}/actors/acct-persist`);
    const actor = await res.json();
    expect(actor).toBeDefined();
    expect(actor.history.length).toBe(2);
    await loaded.stop();
  });

  test('version upgrades trigger per-actor migration rule', async () => {
    // make two actors with differing history lengths
    await mock.sendEvent({ actorId: 'a-one', type: 'EV1' }); // length 1 -> odd
    await mock.sendEvent({ actorId: 'a-two', type: 'EV1' });
    await mock.sendEvent({ actorId: 'a-two', type: 'EV2' }); // length 2 -> even

    // ask mock to migrate both to v2
    const migrate = async (actorId) => {
      const res = await fetch(`${mock.url()}/migrate`, {
        method: 'POST',
        body: JSON.stringify({ actorId, newVersion: 'v2' }),
        headers: { 'content-type': 'application/json' },
      });
      return res.json();
    };

    const r1 = await migrate('a-one');
    const r2 = await migrate('a-two');

    // our mock's rule migrates odd-history actors only
    expect(r1.migrated).toBe(true);
    expect(r2.migrated).toBe(false);
  });
});
