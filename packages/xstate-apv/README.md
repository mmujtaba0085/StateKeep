# @statekeep/xstate-apv

Move long-running **XState v5** actors to new machine versions by the *path they took* —
with a preview, state mapping, and a guarantee that no actor is stranded. No server needed:
it wraps XState's own persist/restore.

```js
import { createVersionRouter } from '@statekeep/xstate-apv';

const router = createVersionRouter({
  versions: { 'loan-v1': loanV1, 'loan-v2': loanV2, 'loan-v3': loanV3 },
  releases: [
    // everyone moves; the renamed state is mapped
    { from: 'loan-v1', to: 'loan-v2', stateMapping: { info_needed: 'awaiting_documents' } },
    // only applications that were sent back for more info get senior sign-off
    { from: 'loan-v2', to: 'loan-v3', historyPath: ['SUBMIT', 'REQUEST_INFO', 'RESUBMIT'] },
  ],
});

let rec = router.restore(await db.load(id));      // upgrades if a release applies
rec = router.send(rec, { type: 'APPROVE' });      // may upgrade just before the event
await db.save(id, router.persist(rec));           // { version, snapshot, history }

router.plan(allSavedRecords);                     // { moves, stays, stranded } — changes nothing
```

Rules: a release without `historyPath` moves every actor on `from`; with it, an actor moves
when its event history is exactly that path (at restore, or just before its next event — never
retroactively). An actor whose state is missing in the target and not mapped stays on its
version and is reported as `stranded`. `contextTransform: { 'new.path': 'old.path' }` copies
fields. Releases chain (v1→v2→v3).

It is the same routing model as the StateKeep server, for teams that want to keep XState in
their own process. When XState v6's `machineVersions()` stabilises, the release list maps onto it.
