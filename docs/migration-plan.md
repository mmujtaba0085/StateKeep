# Migration plan in pull requests

`statekeep plan` answers "what will this release do to the actors running in production?"
before anything is deployed — like `terraform plan`.

```bash
STATEKEEP_URL=https://statekeep.internal STATEKEEP_API_KEY=... \
  statekeep plan definitions/loan-v2.definition.json
```

A definition file is the same JSON you would `PUT /v1/definitions`
(`id`, `parentId`, `definition`, optional `stateMapping`, `historyPath`, `contextTransform`).

The report lists, per release: actors that would move (by current state), actors that would be
stranded (in states the new version removes without a mapping), states added/removed, a suggested
`stateMapping`, and warnings. Exit codes: `0` safe, `3` would strand actors (`--fail-on none`
to only report), `2` error. `--json` prints the structured result.

## GitHub Action

Copy `examples/github/migration-plan.yml` into `.github/workflows/`. On every pull request that
touches `*.definition.json`, it plans the changed files against your server (read-only calls),
posts/updates one PR comment, writes the report to the job summary, and fails the check if the
release would strand actors.

```yaml
- uses: mmujtaba0085/StateKeep/.github/actions/migration-plan@v1
  with:
    statekeep-url: ${{ vars.STATEKEEP_URL }}
    api-key: ${{ secrets.STATEKEEP_API_KEY }}
```
