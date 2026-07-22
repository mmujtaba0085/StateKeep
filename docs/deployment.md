# StateKeep Deployment Guide

Production deployment checklist, Caddy/Nginx TLS termination config, and systemd unit files. For the full API reference, see `docs/API.md`.

---

## Prerequisites

- Linux x86_64 (Ubuntu 22.04+ or Debian 12+ recommended)
- Node.js 20+ (`node --version`)
- Nginx 1.18+ for TLS termination
- A valid TLS certificate (Let's Encrypt via Certbot recommended)

> **APV engine:** The pre-built WASM engine (`src/ffi/apv-engine.mjs`) is included in the repository — no build step is required. Rebuilding the engine requires proprietary C source not included in the open-source release.

---

## Directory Layout

```
/opt/statekeep/
├── app/                  # Application source
│   ├── src/
│   │   └── ffi/
│   │       └── apv-engine.mjs  # APV WASM engine (included in repo)
│   ├── package.json
│   └── ...
├── data/
│   └── statekeep.db      # SQLite database (WAL mode)
└── archives/             # Gzip-compressed actor snapshots (gc-worker output)

/var/log/statekeep/       # Pino rolling log files
```

---

## Environment Variables

Copy `.env.example` to `/opt/statekeep/app/.env` and fill in all values:

```bash
# 32-byte AES-256-GCM encryption key (hex-encoded, 64 chars)
STATEKEEP_ENCRYPTION_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")

# SQLite database path
STATEKEEP_DB_PATH=/opt/statekeep/data/statekeep.db

# HTTP port (Nginx proxies this — do not expose directly)
PORT=3001

# Admin key for admin-only endpoints (X-Admin-Key header)
STATEKEEP_ADMIN_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")

# Log directory
LOG_DIR=/var/log/statekeep

# Worker sizing
ACTORS_PER_WORKER=500
HOT_REGISTRY_SIZE=10000
IDLE_TIMEOUT_SECONDS=300

# Confirm-token settings
CONFIRM_TOKEN_TTL_MS=30000
CONFIRM_DRIFT_THRESHOLD=0

NODE_ENV=production
```

**Important:** Never commit `.env`. Restrict permissions: `chmod 600 /opt/statekeep/app/.env`.

---

## systemd Unit Files

### API Server — `statekeep-api.service`

```ini
[Unit]
Description=StateKeep API Server
After=network.target
Requires=network.target

[Service]
Type=simple
User=statekeep
Group=statekeep
WorkingDirectory=/opt/statekeep/app
EnvironmentFile=/opt/statekeep/app/.env
ExecStart=/usr/bin/node --env-file=.env src/api/server.js
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=statekeep-api

# Security hardening
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/statekeep/data /var/log/statekeep
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

### Migration Worker — `statekeep-migrate-worker.service`

```ini
[Unit]
Description=StateKeep Migration Worker
After=statekeep-api.service
Requires=statekeep-api.service

[Service]
Type=simple
User=statekeep
Group=statekeep
WorkingDirectory=/opt/statekeep/app
EnvironmentFile=/opt/statekeep/app/.env
ExecStart=/usr/bin/node --env-file=.env src/workers/migrate-worker.js
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=statekeep-migrate

NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/statekeep/data /var/log/statekeep
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

### GC Worker — `statekeep-gc-worker.service`

```ini
[Unit]
Description=StateKeep GC Worker
After=statekeep-api.service

[Service]
Type=simple
User=statekeep
WorkingDirectory=/opt/statekeep/app
EnvironmentFile=/opt/statekeep/app/.env
ExecStart=/usr/bin/node --env-file=.env src/workers/gc-worker.js
Restart=always
RestartSec=30
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/opt/statekeep/data /opt/statekeep/archives /var/log/statekeep
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

### Snapshot Worker — `statekeep-snapshot-worker.service`

```ini
[Unit]
Description=StateKeep Snapshot Worker
After=statekeep-api.service

[Service]
Type=simple
User=statekeep
WorkingDirectory=/opt/statekeep/app
EnvironmentFile=/opt/statekeep/app/.env
ExecStart=/usr/bin/node --env-file=.env src/workers/snapshot-worker.js
Restart=always
RestartSec=30
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/opt/statekeep/data /var/log/statekeep
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

### Metrics Worker — `statekeep-metrics-worker.service`

```ini
[Unit]
Description=StateKeep Metrics Worker
After=statekeep-api.service

[Service]
Type=simple
User=statekeep
WorkingDirectory=/opt/statekeep/app
EnvironmentFile=/opt/statekeep/app/.env
ExecStart=/usr/bin/node --env-file=.env src/workers/metrics-worker.js
Restart=always
RestartSec=30
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/opt/statekeep/data /var/log/statekeep
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

### Webhook Worker — `statekeep-webhook-worker.service`

```ini
[Unit]
Description=StateKeep Webhook Worker
After=statekeep-api.service

[Service]
Type=simple
User=statekeep
WorkingDirectory=/opt/statekeep/app
EnvironmentFile=/opt/statekeep/app/.env
ExecStart=/usr/bin/node --env-file=.env src/workers/webhook-worker.js
Restart=always
RestartSec=10
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/opt/statekeep/data /var/log/statekeep
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

### Scheduler Worker — `statekeep-scheduler-worker.service`

```ini
[Unit]
Description=StateKeep Scheduler Worker
After=statekeep-api.service

[Service]
Type=simple
User=statekeep
WorkingDirectory=/opt/statekeep/app
EnvironmentFile=/opt/statekeep/app/.env
ExecStart=/usr/bin/node --env-file=.env src/workers/scheduler-worker.js
Restart=always
RestartSec=10
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/opt/statekeep/data /var/log/statekeep
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

Install and enable all services:

```bash
for svc in statekeep-api statekeep-migrate-worker statekeep-gc-worker \
            statekeep-snapshot-worker statekeep-metrics-worker \
            statekeep-webhook-worker statekeep-scheduler-worker; do
  cp ${svc}.service /etc/systemd/system/
done
systemctl daemon-reload
systemctl enable --now statekeep-api statekeep-migrate-worker statekeep-gc-worker \
  statekeep-snapshot-worker statekeep-metrics-worker \
  statekeep-webhook-worker statekeep-scheduler-worker
```

---

## Nginx TLS Termination

```nginx
# /etc/nginx/sites-available/statekeep
server {
    listen 80;
    server_name statekeep.yourcompany.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name statekeep.yourcompany.com;

    # TLS — Let's Encrypt (Certbot manages these paths)
    ssl_certificate     /etc/letsencrypt/live/statekeep.yourcompany.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/statekeep.yourcompany.com/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_ciphers         HIGH:!aNULL:!MD5;
    ssl_session_cache   shared:SSL:10m;
    ssl_session_timeout 10m;

    # HSTS (enable after confirming TLS works)
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;

    # Proxy to StateKeep API
    location / {
        proxy_pass         http://127.0.0.1:3001;
        proxy_http_version 1.1;

        # WebSocket support
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection "upgrade";

        # Standard proxy headers
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Timeouts
        proxy_read_timeout   300s;
        proxy_connect_timeout 10s;
        proxy_send_timeout    60s;

        # Body size (actor context + definition JSON can be large)
        client_max_body_size 2m;
    }

    # Serve Swagger UI docs at /docs
    location /docs {
        proxy_pass http://127.0.0.1:3001/docs;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

Enable:

```bash
ln -s /etc/nginx/sites-available/statekeep /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
```

---

## APV Engine

The APV WASM engine (`src/ffi/apv-engine.mjs`) is included in the repository and requires no separate installation. It is loaded automatically at startup via `src/ffi/engine.js`.

```bash
# Verify the engine loads correctly
node -e "import('./src/ffi/engine.js').then(m => m.engineReady).then(() => console.log('engine ok'))" \
  --env-file=/opt/statekeep/app/.env
```

The server logs `[ffi/engine] Loaded WASM APV engine` on successful load. If `apv-engine.mjs` is missing, the server will fail to start and print a build instruction.

---

## Let's Encrypt Certificate (Certbot)

```bash
apt install certbot python3-certbot-nginx
certbot --nginx -d statekeep.yourcompany.com
# Auto-renewal via cron is configured automatically by certbot
```

---

## Health Check

```bash
curl https://statekeep.yourcompany.com/v1/health
# Expected: {"status":"ok","engine":"wasm","db":"ok",...}
```

`"engine":"wasm"` confirms the APV WASM engine is loaded and operational. If `apv-engine.mjs` is missing, the server fails to start — there is no fallback mode.

---

## Firewall

Only expose ports 80 and 443 externally. Port 3001 must only be accessible from localhost (Nginx proxy):

```bash
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 22/tcp   # SSH
ufw deny 3001/tcp  # Block direct access to app port
ufw enable
```

---

## Litestream Continuous Backup

Litestream replicates the SQLite WAL to a local or remote destination in real time, providing near-zero RPO without stopping the database.

### Install

```bash
# Download latest release (no sudo needed — install to ~/bin)
mkdir -p ~/bin
curl -sL https://github.com/benbjohnson/litestream/releases/latest/download/litestream-linux-amd64.tar.gz \
  | tar -xz -C ~/bin
chmod +x ~/bin/litestream
```

### Configure (`/opt/statekeep/litestream.yml`)

```yaml
dbs:
  - path: /opt/statekeep/data/statekeep.db
    replicas:
      - path: /opt/statekeep/data/backups
```

For S3 replication:
```yaml
dbs:
  - path: /opt/statekeep/data/statekeep.db
    replicas:
      - type: s3
        bucket: my-statekeep-backups
        path: statekeep.db
```

### Run with PM2 or systemd

```bash
# PM2
pm2 start "~/bin/litestream replicate -config /opt/statekeep/litestream.yml" --name statekeep-litestream

# systemd (statekeep-litestream.service)
ExecStart=/home/statekeep/bin/litestream replicate -config /opt/statekeep/litestream.yml
```

### Restore from backup

```bash
# Stop the API and all workers first
systemctl stop statekeep-api statekeep-migrate-worker   # (and all other workers)

# Restore
~/bin/litestream restore -config /opt/statekeep/litestream.yml /opt/statekeep/data/statekeep.db

# Restart
systemctl start statekeep-api statekeep-migrate-worker  # (and all other workers)
```

---

## Monitoring & Alerting

### Prometheus

Add a scrape target to your `prometheus.yml`:

```yaml
scrape_configs:
  - job_name: statekeep
    static_configs:
      - targets: ['statekeep.yourcompany.com:443']
    scheme: https
    metrics_path: /v1/metrics
```

### Alert rules

Pre-written Prometheus alert rules are in `monitoring/alerts.yml`. Load them:

```yaml
rule_files:
  - /opt/statekeep/app/monitoring/alerts.yml
```

Key alerts:
| Alert | Condition | Action |
|-------|-----------|--------|
| ~~`APVEngineFallback`~~ | _(retired)_ — the server fails to start if `apv-engine.mjs` is missing; there is no fallback mode | Ensure `src/ffi/apv-engine.mjs` is present before starting the server |
| `ActorMigrationFailed` | Migration failures in last 5m | Check `GET /v1/actors?status=needs_rescue` |
| `APILatencyHigh` | P99 > 500ms for 5m | Increase `HOT_REGISTRY_SIZE` or `ACTORS_PER_WORKER` |
| `PendingMigrationJobsStalling` | > 1000 jobs queued for 15m | Verify migrate-worker is running |
| `WALSizeGrowing` | WAL > 100MB for 30m | Run `PRAGMA wal_checkpoint(TRUNCATE)` |

---

## Operations Runbook

### After deploying a new code version

```bash
git pull origin master
pm2 restart statekeep        # Restart API server
# Workers pick up new code on next restart cycle — force if needed:
pm2 restart statekeep-migrate
```

### Restart order (fresh start)

Start API server first — workers depend on DB schema being current:

```bash
pm2 start statekeep
sleep 3   # Wait for schema migrations
pm2 start statekeep-migrate statekeep-gc statekeep-snapshot statekeep-metrics
```

### Manual DB checkpoint

Run if WAL file is growing large:

```bash
node -e "
  import('better-sqlite3').then(({default: Database}) => {
    const db = new Database(process.env.STATEKEEP_DB_PATH);
    console.log(db.pragma('wal_checkpoint(TRUNCATE)'));
    db.close();
  });
" --env-file=/opt/statekeep/app/.env
```

### Check for stale worker heartbeats

```bash
curl -s https://statekeep.yourcompany.com/v1/health/workers | jq '.workers[] | select(.healthy == false)'
```

If a worker shows unhealthy but the process is running, delete its stale record:

```bash
curl -X DELETE https://statekeep.yourcompany.com/v1/health/workers/<workerId> \
  -H "X-Admin-Key: <STATEKEEP_ADMIN_KEY>"
```

### Health verification checklist (after any deploy)

```bash
curl -s .../v1/health          | jq '.status,.engine'     # "ok","wasm"
curl -s .../v1/health/workers  | jq '.healthy'            # true
pm2 status                                                 # all "online"
ls -lh /opt/statekeep/data/statekeep.db                   # DB accessible
ls /opt/statekeep/data/backups/                            # Litestream running
```
