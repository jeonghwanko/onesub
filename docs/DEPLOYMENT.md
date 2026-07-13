# Deployment Guide

OneSub is Express middleware, not a hosted service. The host owns HTTP authentication, process
management, secrets, durable stores, backups, and public webhook routing.

## Choose a Topology

### Local or disposable environment

```text
App -> one Node process -> in-memory stores/cache
```

Use this only for development and tests. Restarting loses subscription and purchase state.

### Small production deployment

```text
App / Apple / Google -> reverse proxy -> OneSub Node process -> PostgreSQL
```

Use PostgreSQL as the durable subscription/purchase store. Source webhook retries provide basic
durability when processing remains inline.

### Multi-instance production deployment

```text
                         +-> OneSub process --+
App / stores -> proxy ---+                    +-> PostgreSQL
                         +-> OneSub process --+
                                  |
                                  +-> Redis cache + idempotency + BullMQ
```

PostgreSQL remains the system of record. Redis shares short-lived provider tokens, atomically
deduplicates webhook events, and persists BullMQ jobs across application instances.

## Install Optional Infrastructure Peers

```bash
npm install @onesub/server express
npm install pg
npm install ioredis bullmq
npm install @opentelemetry/api # only when tracing is configured
```

Only install the peers used by the selected topology.

## PostgreSQL Deployment

```ts
import {
  createOneSubMiddleware,
  PostgresSubscriptionStore,
  PostgresPurchaseStore,
} from '@onesub/server';

const databaseUrl = process.env.DATABASE_URL!;
const store = new PostgresSubscriptionStore(databaseUrl);
const purchaseStore = new PostgresPurchaseStore(databaseUrl);

await store.initSchema();
await purchaseStore.initSchema();

app.use(createOneSubMiddleware({
  ...providerConfig,
  database: { url: databaseUrl },
  store,
  purchaseStore,
  adminSecret: process.env.ADMIN_SECRET,
}));
```

The canonical DDL is shipped as `@onesub/server/sql/schema.sql`. Choose one schema owner:

- Call both `initSchema()` methods at startup.
- Apply the shipped SQL with your migration system.
- Mount it into PostgreSQL's `docker-entrypoint-initdb.d` for a new disposable database.

All DDL is designed for safe repeated initialization, but production teams should still record
schema changes in their normal migration history. See [`POSTGRES.md`](POSTGRES.md).

## Redis and Durable Webhooks

```ts
import IORedis from 'ioredis';
import {
  RedisCacheAdapter,
  RedisWebhookEventStore,
  BullMQWebhookQueue,
} from '@onesub/server';

const redis = new IORedis(process.env.REDIS_URL!, {
  maxRetriesPerRequest: null,
});

const cache = new RedisCacheAdapter(redis);
const webhookEventStore = new RedisWebhookEventStore(redis);
const webhookQueue = new BullMQWebhookQueue({
  connection: redis,
  maxAttempts: 5,
  backoffMs: 1_000,
  concurrency: 4,
});

app.use(createOneSubMiddleware({
  ...providerConfig,
  database: { url: databaseUrl },
  store,
  purchaseStore,
  cache,
  webhookEventStore,
  webhookQueue,
  adminSecret: process.env.ADMIN_SECRET,
}));
```

`RedisWebhookEventStore` uses atomic `SET NX` and is preferred over `CacheWebhookEventStore` for
multi-instance delivery. The BullMQ implementation starts its worker when middleware registers the
handler. After the queue accepts a job, the webhook route can acknowledge without waiting for the
provider/store mutation pipeline.

Jobs use bounded exponential retry. Exhausted jobs appear at:

```text
GET  /onesub/admin/webhook-deadletters
POST /onesub/admin/webhook-replay/:id
```

Both require `X-Admin-Secret`. Alert on dead-letter growth; replay only after correcting the root
cause to avoid an immediate repeat failure.

Redis can also be the subscription/purchase store through `RedisSubscriptionStore` and
`RedisPurchaseStore`. Prefer PostgreSQL when SQL reporting, backups, and dashboard-oriented queries
are primary requirements.

## Public Routes and Reverse Proxies

Store endpoints must be reachable over HTTPS:

```text
POST https://api.example.com/onesub/webhook/apple
POST https://api.example.com/onesub/webhook/google
```

If middleware is mounted under a prefix, include it everywhere:

```ts
app.use('/api', createOneSubMiddleware(config));
// Public status route: /api/onesub/status
```

Set `google.pushAudience` to the exact public Pub/Sub endpoint URL. Also set
`google.pushServiceAccountEmail` so a token for the same audience but another service account is
rejected.

Validation and status routes do not authenticate application users. Mount host authentication and
derive `userId` from the authenticated session rather than trusting arbitrary public input. Do not
place host authentication in front of Apple/Google webhook routes unless it explicitly supports the
stores' authentication scheme.

## Health and OpenAPI

`createOneSubServer()` includes `GET /health`. When mounting middleware into an existing Express
application, define the health endpoint in the host and include dependency checks appropriate to the
deployment.

The server exports `ONESUB_OPENAPI` and `openapiHandler()` but does not automatically mount an
OpenAPI route:

```ts
import { openapiHandler } from '@onesub/server';

app.get('/openapi.json', openapiHandler);
```

Protect or omit internal/admin operations in externally published API portals as required by the
host security model.

## Dashboard

The dashboard is a separate Next.js process on port 4101:

```bash
docker run -p 4101:4101 \
  -e ONESUB_SERVER_URL=https://api.example.com \
  ghcr.io/jeonghwanko/onesub-dashboard:latest
```

It stores the entered `adminSecret` in an HTTP-only cookie and makes server-side requests to the
OneSub server. Serve it over HTTPS with `NODE_ENV=production` so the cookie receives the Secure flag.
The dashboard is single-operator by design; restrict network access accordingly.

## Secrets

Store these only in a secret manager or protected runtime environment:

- Apple `.p8` private keys, issuer/key IDs, and promotional-offer private key.
- Google service-account JSON.
- PostgreSQL and Redis URLs when they contain credentials.
- `adminSecret`.
- Receipts and purchase tokens captured for support or E2E work.

The Apple App Store Server API key and promotional-offer key have different scopes. Do not reuse one
private key value for both configuration fields. Never ship any of these secrets in React Native or
Unity assets.

## Graceful Shutdown

Stop accepting HTTP traffic, wait for in-flight requests, then close owned resources:

```ts
const httpServer = app.listen(port);

async function shutdown() {
  httpServer.close(async () => {
    await webhookQueue?.close?.();
    await store.close?.();
    await purchaseStore.close?.();
    await redis?.quit();
    process.exit(0);
  });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
```

The built-in PostgreSQL stores expose `close()`, and `BullMQWebhookQueue` exposes optional `close()`.
Custom stores/queues should provide equivalent lifecycle handling in the host.

## Backups and Recovery

- Back up PostgreSQL using the same policy as other entitlement-critical data.
- Test restores, including indexes and schema additions.
- Treat Redis queue persistence according to the chosen Redis durability policy; cache loss is
  recoverable, queued webhook loss may require store retries or reconciliation.
- Keep Apple/Google webhook configuration documented outside the running instance.
- Use the Apple admin sync/Transaction History client and client re-validation as reconciliation
  tools; do not treat Redis cache contents as a source of truth.

## Production Checklist

- [ ] `NODE_ENV=production` and mock/degraded verification options are absent.
- [ ] Durable subscription and purchase stores are explicitly passed.
- [ ] PostgreSQL schema is initialized and backed up.
- [ ] Google push audience and service-account email are configured.
- [ ] HTTPS webhook URLs return 2xx for valid test notifications.
- [ ] Admin/dashboard routes use a strong secret and restricted network exposure.
- [ ] Multi-instance deployments use shared idempotency and a durable queue.
- [ ] Dead letters, provider timeouts, and validation error rates are monitored.
- [ ] Graceful shutdown closes HTTP, queue, database, and Redis resources.
- [ ] Sandbox and production receipt flows have been smoke-tested.
