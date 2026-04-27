# onesub benchmarks

[k6](https://k6.io) load tests for the HTTP surface. Used to:

- catch performance regressions in CI (the "bench" workflow runs both
  scripts against an in-memory configuration and uploads the summary)
- compare backends — Postgres vs Redis vs in-memory store under the same
  workload

## Scripts

| File | Path | Notes |
|------|------|-------|
| [status.k6.js](status.k6.js) | `GET /onesub/status?userId=` | Read-heavy; SubscriptionStore.getByUserId |
| [webhook.k6.js](webhook.k6.js) | `POST /onesub/webhook/google` | Write-heavy; persists state on every call |

## Running locally

```bash
# Boot the example server (in-memory, no Redis/Postgres)
cd examples/server
docker compose up -d
cd ../..

# Run the read benchmark — 50 VUs for 30s
k6 run -e BASE_URL=http://localhost:4100 bench/status.k6.js

# Run the write benchmark — 20 VUs for 30s
k6 run -e BASE_URL=http://localhost:4100 bench/webhook.k6.js
```

## Comparing backends

To compare in-memory vs Redis vs Postgres latency:

```bash
# In-memory (default)
docker compose down -v
docker compose up -d
k6 run -e BASE_URL=http://localhost:4100 bench/status.k6.js

# Postgres
docker compose down
DATABASE_URL=postgresql://onesub:onesub@db:5432/onesub docker compose up -d
k6 run -e BASE_URL=http://localhost:4100 bench/status.k6.js

# Redis
docker compose down
REDIS_URL=redis://redis:6379 docker compose up -d
k6 run -e BASE_URL=http://localhost:4100 bench/status.k6.js
```

## Thresholds

The shipped scripts fail the run if:

- Status: p95 > 100ms or p99 > 300ms
- Webhook: p95 > 200ms or p99 > 500ms
- Either: error rate > 1%

These targets are calibrated against in-memory; raise them locally when
benchmarking Postgres at scale (network round-trip dominates).
