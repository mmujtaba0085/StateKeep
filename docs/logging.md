# StateKeep Logging Guide

StateKeep uses [Pino](https://getpino.io/) for structured JSON logging with rolling file output in production.

---

## Log Format

All log lines are newline-delimited JSON:

```json
{
  "level": 30,
  "time": 1714022445123,
  "pid": 12345,
  "hostname": "prod-server-1",
  "requestId": "550e8400-e29b-41d4-a716-446655440000",
  "req": { "method": "POST", "url": "/v1/actors", "remoteAddress": "10.0.0.1" },
  "res": { "statusCode": 201 },
  "responseTime": 4.2,
  "msg": "request completed"
}
```

### Level Numbers

| Level | Name  | When used                              |
|-------|-------|----------------------------------------|
| 10    | trace | Verbose debugging (disabled in prod)   |
| 20    | debug | Internal state, DB queries             |
| 30    | info  | Normal operation, request completion   |
| 40    | warn  | Recoverable issues, cache misses       |
| 50    | error | Errors that affected a request         |
| 60    | fatal | Startup failures, unrecoverable errors |

Set `LOG_LEVEL=debug` in `.env` for verbose output during development.

---

## Log Files

In `NODE_ENV=production`, logs are written to rolling files via `pino-roll`:

```
/var/log/statekeep/
├── statekeep-api.2026-05-17.log
├── statekeep-api.2026-05-16.log
└── ...   (7 days retained)
```

In development (`NODE_ENV=development` or unset), logs go to stdout as pretty-printed JSON.

---

## Key Structured Fields

| Field          | Type    | Description                                          |
|----------------|---------|------------------------------------------------------|
| `requestId`    | string  | UUID per request (echoed as `X-Request-Id` header)   |
| `actorId`      | string  | Set on actor-specific log lines                      |
| `definitionId` | string  | Set on definition deployment log lines               |
| `orgId`        | string  | Organisation context for all authenticated requests  |
| `engine`       | string  | `wasm` — APV WASM engine loaded and operational      |
| `migrated`     | number  | Count of actors migrated in a deployment batch       |
| `failed`       | number  | Count of failed migration jobs                       |
| `workerIndex`  | number  | Actor worker thread index                            |

Sensitive fields are automatically redacted: `req.headers["x-api-key"]` is replaced with `[Redacted]` in all log lines.

---

## Loki Integration (Grafana)

Install Promtail on the host and configure it to ship StateKeep log files to Loki:

```yaml
# /etc/promtail/config.yml
server:
  http_listen_port: 9080

clients:
  - url: http://loki:3100/loki/api/v1/push

scrape_configs:
  - job_name: statekeep
    static_configs:
      - targets: [localhost]
        labels:
          job:      statekeep
          host:     __HOSTNAME__
          __path__: /var/log/statekeep/*.log
    pipeline_stages:
      - json:
          expressions:
            level:     level
            requestId: requestId
            actorId:   actorId
            orgId:     orgId
      - labels:
          level:
          orgId:
      - timestamp:
          source: time
          format: UnixMs
```

Useful Loki queries:

```logql
# All errors in the last hour
{job="statekeep"} | json | level >= 50

# Migration failures for a specific org
{job="statekeep"} | json | orgId="acme-corp" | msg =~ "(?i)migration.*fail"

# Actor operations for a specific actor
{job="statekeep"} | json | actorId="550e8400-e29b-41d4-a716-446655440000"

# Request latency > 500ms
{job="statekeep"} | json | responseTime > 500
```

---

## Datadog Integration

Use the Datadog Agent's log collection with Autodiscovery:

```yaml
# /etc/datadog-agent/conf.d/statekeep.d/conf.yaml
logs:
  - type: file
    path: /var/log/statekeep/*.log
    service: statekeep
    source: nodejs
    sourcecategory: sourcecode
    log_processing_rules:
      - type: multi_line
        name: new_log_start_with_date
        pattern: '^\{"level"'
```

Add a pipeline in the Datadog UI to parse the Pino JSON format and promote `level`, `requestId`, `actorId`, and `orgId` as facets for filtering.

---

## Log Retention

The default retention is 7 daily log files (~1 week). Adjust via the `pino-roll` `limit.count` option in `src/api/server.js`:

```js
limit: { count: 30 }   // keep 30 days
```

For longer retention, ship logs to an external system (Loki, Datadog, CloudWatch) and reduce local retention to 3–7 days.

---

## Structured Error Logging

Worker and migration errors include structured context:

```json
{
  "level": 50,
  "msg": "[migrate-worker] Job 42 failed for actor abc-123",
  "actorId": "abc-123",
  "targetDefId": "checkout-v2",
  "error": "STATE_NOT_MAPPABLE"
}
```

Filter by `msg =~ "STATE_NOT_MAPPABLE"` to find actors that need manual rescue intervention.
