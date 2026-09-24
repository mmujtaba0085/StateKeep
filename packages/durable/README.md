# @statekeep/durable

Write long-running workflows as plain async functions. Runs are stored in
StateKeep; they survive crashes and deploys, and **runs already in progress move to
new code versions based on the steps they have completed**.

```js
import { createEngine } from '@statekeep/durable';

const onboarding = {
  v1: async (ctx, input) => {
    const acct = await ctx.step('createAccount', () => accounts.create(input));
    await ctx.waitForEvent('EMAIL_VERIFIED');
    await ctx.step('sendWelcome', () => mail.welcome(acct.id));
    return { accountId: acct.id };
  },
  v2: async (ctx, input) => {                     // new rule: KYC after account creation
    const acct = await ctx.step('createAccount', () => accounts.create(input));
    await ctx.step('kycCheck', () => kyc.check(acct.id));
    await ctx.waitForEvent('EMAIL_VERIFIED');
    await ctx.step('sendWelcome', () => mail.welcome(acct.id));
    return { accountId: acct.id };
  },
};

const engine = createEngine({
  url: 'http://localhost:3001', apiKey: process.env.STATEKEEP_API_KEY,
  workflows: { onboarding },
  releases: [{ workflow: 'onboarding', from: 'v1', to: 'v2' }],
});
await engine.setup();
const id = await engine.start('onboarding', { email: 'a@b.c' });   // newest version
await engine.signal(id, 'EMAIL_VERIFIED');
setInterval(() => engine.resumeAll(), 5000);                         // crash recovery + timers
```

| API | |
|---|---|
| `ctx.step(name, fn, { retries })` | Runs `fn` once and records its (JSON) result; replayed on resume. `fn` gets `{ key }` for downstream idempotency |
| `ctx.waitForEvent(name)` | Suspends until `engine.signal(runId, name, payload)`; returns the payload. Signals sent early are kept |
| `ctx.sleep(ms)` | Durable timer; fired by `resumeAll()` |
| `engine.preview(release)` | Dry run: which runs would move, which stay, which are incompatible and why |
| `engine.get(runId)` | Status, version, completed steps, what it waits for |

## Version routing

A release `{ workflow, from, to }` moves a run at its next checkpoint (when it resumes,
or right after a step completes) **only if the new code, replayed against the run's
recorded steps, asks for exactly those steps in that order**. Otherwise the run stays on
the old version and finishes with the old code — `preview()` shows the reason:

```
new code expects step "kycCheck" at #1, but the run recorded signal "EMAIL_VERIFIED"
```

- `when: ['createAccount', 'kycCheck']` — only runs whose completed steps are exactly this
  (StateKeep's `historyPath`).
- `renameSteps: { sendWelcome: 'sendWelcomeEmail' }` — cross a step rename (StateKeep's
  `stateMapping`).
- Completed/failed runs never move; releases chain (v1 → v2 → v3); the first matching
  release for a version applies.

Compared with other engines: Temporal asks you to branch inside one function
(`patched()` / `getVersion()`), and Restate keeps in-flight invocations on the deployment
they started on. Here the versions stay separate functions, and each run is checked and
moved automatically when that is safe.

## Rules and limits

- Code outside `ctx.step` must be deterministic (no I/O, `Date.now()`, `Math.random()`),
  exactly as with other replay-based engines.
- Steps are at-least-once: a crash between the side effect and the commit repeats the step.
  Use the `key` for idempotency downstream.
- Step results are stored in the run's context — keep them small (store references).
- One signal slot per name (a second signal of the same name before it is consumed
  replaces the first).
- JavaScript only for now; the storage format (`sk-durable-run-v1` actors) is plain JSON,
  so a Python/Go engine can share runs.

Tested in `test.js` against a real server: steps run once across restarts, early signals,
v1 → v2 routing with an incompatible run left on v1, `when` targeting, step rename,
durable timer, two engines racing on one run, and a worker process killed mid-step.
