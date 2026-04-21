# onesub server example

Minimal Express server with Apple + Google receipt validation.

## Quick Start

```bash
cd examples/server
cp .env.example .env    # fill in your credentials
npm install
npm start               # http://localhost:4100
```

## Test it

```bash
# Check health
curl http://localhost:4100/health

# Check subscription status
curl http://localhost:4100/onesub/status?userId=test-user-123

# Validate a receipt (from your mobile app)
curl -X POST http://localhost:4100/onesub/validate \
  -H "Content-Type: application/json" \
  -d '{"platform":"apple","receipt":"<JWS_RECEIPT>","userId":"test-user-123","productId":"premium_monthly"}'
```

## With PostgreSQL

```bash
# Set DATABASE_URL in .env
DATABASE_URL=postgresql://user:pass@localhost:5432/onesub

# The table is auto-created on startup
npm start
```

Schema is defined canonically in [`packages/server/sql/schema.sql`](../../packages/server/sql/schema.sql).
Apply it manually if you manage migrations yourself:

```bash
psql "$DATABASE_URL" -f ../../packages/server/sql/schema.sql
```

## With Docker Compose (server + Postgres)

Fastest way to get a full stack running — Postgres auto-initialized with the
onesub schema, server wired up to it:

```bash
cd examples/server
cp .env.example .env      # fill in Apple/Google credentials (DATABASE_URL is set by compose)
docker compose up         # http://localhost:4100
```

The Postgres volume persists across `docker compose down`. To wipe the DB and
re-run the schema init:

```bash
docker compose down -v
```

## Production image

For an immutable production-style image (installs `@onesub/server` from npm,
no workspace bind mount, non-root user, healthcheck built in) use
[`Dockerfile`](Dockerfile) instead:

```bash
docker build -t onesub-server -f Dockerfile .
docker run --rm -p 4100:4100 --env-file .env onesub-server
```

## Mount in your existing app

If you already have an Express server, skip this example and just add one line:

```js
import { createOneSubMiddleware } from '@onesub/server';
app.use(createOneSubMiddleware(config));
```
