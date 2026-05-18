# ── Stage 1: dependency install ───────────────────────────────────────────────
FROM node:20-alpine AS deps

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ── Stage 2: runtime image ────────────────────────────────────────────────────
FROM node:20-alpine AS runtime

# Non-root user for security hardening
RUN addgroup -S statekeep && adduser -S statekeep -G statekeep

WORKDIR /app

# Copy application source
COPY --chown=statekeep:statekeep src/       ./src/
COPY --chown=statekeep:statekeep package.json ./

# Copy production dependencies from stage 1
COPY --from=deps --chown=statekeep:statekeep /app/node_modules ./node_modules

# Copy the compiled APV engine .so
# The .so is compiled outside this build context (see docs/deployment.md).
# Build with: docker build --build-arg ENGINE_PATH=./libapv-engine.so ...
# Or copy after container start via volume mount.
ARG ENGINE_PATH=./src/ffi/libapv-engine.so
COPY --chown=statekeep:statekeep ${ENGINE_PATH} /opt/statekeep/lib/libapv-engine.so

# Data directory for SQLite and archives
RUN mkdir -p /opt/statekeep/data /opt/statekeep/archives /var/log/statekeep \
    && chown -R statekeep:statekeep /opt/statekeep /var/log/statekeep

USER statekeep

# Environment defaults (override at runtime via --env-file or -e flags)
ENV NODE_ENV=production \
    PORT=3001 \
    STATEKEEP_ENGINE_PATH=/opt/statekeep/lib/libapv-engine.so \
    STATEKEEP_DB_PATH=/opt/statekeep/data/statekeep.db \
    LOG_DIR=/var/log/statekeep \
    ACTORS_PER_WORKER=500 \
    HOT_REGISTRY_SIZE=10000 \
    IDLE_TIMEOUT_SECONDS=300

EXPOSE 3001

# Health check — verifies both API and engine status
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -qO- http://localhost:3001/v1/health | grep -q '"status":"ok"' || exit 1

CMD ["node", "src/api/server.js"]
