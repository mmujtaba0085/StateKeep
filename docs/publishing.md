# Publishing to npm

| Package | Directory | Licence | What it is |
|---|---|---|---|
| `statekeep` | `.` | Apache-2.0 with Commons Clause (`LICENSE`) | The server, workers and CLI (`npx statekeep serve`), with the compiled APV engine |
| `@statekeep/sdk` | `sdk/` | MIT | HTTP client (JavaScript + TypeScript types) |
| `@statekeep/durable` | `packages/durable/` | MIT | Code-first durable workflows on StateKeep |
| `@statekeep/xstate-apv` | `packages/xstate-apv/` | MIT | History-based version routing for plain XState v5 apps |

Each package has a `files` whitelist: the server ships `src/` (no tests, benchmarks or
engine source), `README.md`, `LICENSE`, `.env.example` and `llms.txt`. Check what a package
would contain with `npm pack --dry-run` in its directory.

## One-time setup

1. **npm account** with two-factor authentication: <https://www.npmjs.com/signup>.
2. **Organization `statekeep`** (free plan): <https://www.npmjs.com/org/create>. It owns the
   `@statekeep/` scope. The unscoped name `statekeep` is claimed by the first publish.
3. **Access token**: npmjs.com → Access Tokens → *Generate New Token* → *Granular Access
   Token*, with read and write access to packages and to the `statekeep` organization, and
   an expiry date.
4. **GitHub secret**: repository → Settings → Secrets and variables → Actions → *New
   repository secret*, name `NPM_TOKEN`, value the token.

## Publish

GitHub → Actions → **Publish to npm** → *Run workflow*:

1. package `all`, **dry run on**: tests run, each package is packed and listed, nothing is
   published. Read the file lists.
2. Run it again with **dry run off**. Versions that are already on npm are skipped, so the
   workflow can be re-run safely.

Packages are published with provenance: npm shows that each tarball was built from this
repository by this workflow.

From your own machine instead (no provenance):

```bash
npm login
npm publish --access public                         # statekeep (repo root)
(cd sdk && npm publish --access public)             # builds dist/ first (prepublishOnly)
(cd packages/durable && npm publish --access public)
(cd packages/xstate-apv && npm publish --access public)
```

## Check

```bash
mkdir /tmp/sk-try && cd /tmp/sk-try
npx statekeep serve --port 3300                     # in one terminal
curl localhost:3300/v1/health                       # in another
npm init -y && npm install @statekeep/sdk
```

## Later releases

A published version can never be replaced. Bump the version first (`npm version patch` in
the package's directory, or `minor` when the server's database schema changes), then run
the workflow. For the server, tag the same version (`git tag v1.2.0 && git push --tags`) so
the Docker image and GitHub release match.
