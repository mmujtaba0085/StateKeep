# Testing a cluster on separate machines

The cluster tests run several servers on one machine. To check the same guarantees across
real machines — real network, real clocks — use `scripts/multihost/`.

## Setup

| Machine | Runs |
|---|---|
| M1 | PostgreSQL 14+ (an **empty** database, e.g. `statekeep_mh`), and server A |
| M2 | server B |
| M3 | server C (optional, more is fine) |
| any | the checker (`check.mjs`); it only needs HTTP access to the servers, and ssh for the pause checks |

Each server machine needs Node 22+ and a checkout of StateKeep with `npm ci` run.
Pick three secrets, the same on every machine:

```bash
export API_KEY=$(openssl rand -hex 24) ADMIN_KEY=$(openssl rand -hex 24) ENC_KEY=$(openssl rand -hex 32)
```

## Start the servers

On each machine (its own `NODE_ID` and the URL **the other machines** use to reach it):

```bash
NODE_ID=A DB_URL=postgres://user:pw@M1:5432/statekeep_mh PUBLIC_URL=http://M1:3000 \
API_KEY=$API_KEY ADMIN_KEY=$ADMIN_KEY ENC_KEY=$ENC_KEY \
bash scripts/multihost/node.sh
```

Start A first (it creates the schema), then B and C. Each runs the API server and its
scheduler; logs go to `/tmp/sk-mh-logs`.

**Clock skew.** To test with clocks that disagree, either really set a machine's clock
off (stop NTP, e.g. `sudo timedatectl set-ntp false && sudo date -s '+5 min'`; undo it
afterwards), or add `CLOCK_OFFSET_MS=300000 CLOCK_RATE=1.25` to that server's command
(skews just that process).

## Run the checks

```bash
node scripts/multihost/check.mjs \
  --node A=http://M1:3000 --node B=http://M2:3000 --node C=http://M3:3000 \
  --api-key $API_KEY --hook 'ssh {host} {cmd}' --rounds 3
```

| Check | Needs `--hook` |
|---|---|
| No lost updates: 40 concurrent events per actor through every server | no |
| A deployment through any server routes the next event on every server | no |
| `after:` timers fire on time whichever server created them | no |
| A server frozen before its registry check routes with a deployment committed meanwhile | yes |
| A server frozen mid-event and taken over answers `503 OWNER_CHANGED`; nothing lost or overwritten | yes |

`--hook` is how the checker reaches a server's machine to freeze it at an exact point
(it creates files in `/tmp/sk-mh-hooks` there): `{host}` is the host of the server's URL,
`{cmd}` the command. Without ssh access, leave `--hook` out and the first three checks run.
Exit code 0 when every check passed; send the output (and `/tmp/sk-mh-logs` on failure).

The servers run with `NODE_ENV=test` (needed for the pause points). Use a dedicated
database; do not point this at production.
