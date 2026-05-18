# StateKeep Deployment Guide

Production deployment checklist, Nginx TLS termination config, and systemd unit files.

---

## Prerequisites

- Linux x86_64 (Ubuntu 22.04+ or Debian 12+ recommended)
- Node.js 20+ (`node --version`)
- The compiled `libapv-engine.so` placed at `/opt/statekeep/lib/libapv-engine.so`
- Nginx 1.18+ for TLS termination
- A valid TLS certificate (Let's Encrypt via Certbot recommended)

---

## Directory Layout

```
/opt/statekeep/
├── app/                  # Application source
│   ├── src/
│   ├── package.json
│   └── ...
├── lib/
│   └── libapv-engine.so  # APV engine shared library (gitignored, never committed)
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

# Path to the compiled APV engine
STATEKEEP_ENGINE_PATH=/opt/statekeep/lib/libapv-engine.so

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

Install and enable:

```bash
cp statekeep-api.service         /etc/systemd/system/
cp statekeep-migrate-worker.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now statekeep-api statekeep-migrate-worker
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

## `.so` Placement

The APV engine is a proprietary compiled binary. It is **never** included in the git repository (`.gitignore` lists `*.so` and `src/temp/`).

```bash
# Copy the compiled .so to the production host
scp libapv-engine.so user@host:/opt/statekeep/lib/libapv-engine.so
chmod 755 /opt/statekeep/lib/libapv-engine.so

# Verify it loads correctly
STATEKEEP_ENGINE_PATH=/opt/statekeep/lib/libapv-engine.so \
  node -e "import('./src/ffi/engine.js').then(m => m.engineReady).then(() => console.log('engine ok'))"
```

The server logs `[ffi/engine] APV engine loaded from ...` on successful load, or `no-migration fallback mode active` if loading fails.

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
# Expected: {"status":"ok","engine":"real","db":"ok",...}
```

`"engine":"real"` confirms the APV `.so` is loaded. `"engine":"fallback"` means migrations are disabled — check `STATEKEEP_ENGINE_PATH` and file permissions.

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
