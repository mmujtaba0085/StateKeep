# ── Stage 1: dependency install ───────────────────────────────────────────────
FROM node:22-alpine AS deps

WORKDIR /app

# Build tools needed to compile native modules (better-sqlite3, koffi) from source on Alpine musl
RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ── Stage 2: runtime image ────────────────────────────────────────────────────
FROM node:22-alpine AS runtime

# Non-root user for security hardening
RUN addgroup -S statekeep && adduser -S statekeep -G statekeep

WORKDIR /app

# Application source (includes src/ffi/apv-engine.mjs — the WASM APV engine)
COPY --chown=statekeep:statekeep src/       ./src/
COPY --chown=statekeep:statekeep package.json ./

# Startup script — launches background workers then execs the API server
COPY --chown=statekeep:statekeep start.sh ./
RUN chmod +x start.sh

# Production dependencies from stage 1
COPY --from=deps --chown=statekeep:statekeep /app/node_modules ./node_modules

# Persistent data directory (mount a volume here to survive container restarts)
RUN mkdir -p /opt/statekeep/data /var/log/statekeep \
    && chown -R statekeep:statekeep /opt/statekeep /var/log/statekeep

USER statekeep

ENV NODE_ENV=production \
    PORT=3001 \
    STATEKEEP_DB_PATH=/opt/statekeep/data/statekeep.db \
    LOG_DIR=/var/log/statekeep \
    HOT_REGISTRY_SIZE=10000 \
    IDLE_TIMEOUT_SECONDS=300

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD wget -qO- http://localhost:3001/v1/health | grep -q '"status":"ok"' || exit 1

CMD ["./start.sh"]
