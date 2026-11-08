# Security Policy

## Reporting a Vulnerability

If you find a security vulnerability in StateKeep, please report it privately —
**do not open a public GitHub issue**.

Email **statekeep.support@gmail.com** with:

- a description of the vulnerability and its potential impact;
- steps to reproduce it (a minimal repro, request/response examples, or a
  small test case are all helpful);
- the version or commit you tested against.

You should get an acknowledgement within a few days. We'll keep you updated as
we investigate and fix the issue, and we'll credit you in the release notes
when it's fixed, unless you'd prefer to stay anonymous.

## Supported Versions

StateKeep is pre-1.0-API-stable (currently on the `1.x` line). Security fixes
land on the latest `1.x` release; older `1.x` releases are not separately
patched. Always run the latest tagged release.

| Version | Supported |
|---|---|
| Latest `1.x` | ✅ |
| Older `1.x` | ❌ |

## Scope

In scope:
- the API server, workers, and cluster mode (`src/`);
- the SDKs (`sdk/`, `packages/@statekeep/durable`, `packages/@statekeep/xstate-apv`);
- the dashboard (`src/dashboard/`).

Out of scope:
- the compiled WebAssembly routing engine's behavior as a black box is in
  scope (e.g. a routing decision that violates the guarantees in
  [`docs/apv.md`](docs/apv.md)) — but its proprietary C source is not part of
  this repository and cannot be audited directly;
- third-party dependencies (please report those upstream; we'll update
  promptly once a fix is available — see
  [`npm audit`](https://docs.npmjs.com/cli/v10/commands/npm-audit) in CI).

## A Note on the Routing Guarantees

StateKeep's core correctness claims (deterministic routing, no misrouted
actors, no replayed side effects) are formally modeled and proved — see
[`docs/apv.md`](docs/apv.md) and [`formal/`](formal/). If you find a case
where the running system's behavior contradicts those guarantees, that's a
security-relevant correctness bug: please report it the same way as above.
