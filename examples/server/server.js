/**
 * onesub server example — Express app with receipt validation.
 *
 * Wires up every production hardening primitive when the matching env var is
 * present. Falls back to in-memory defaults for a one-command demo.
 *
 *   - DATABASE_URL → Postgres subscription + purchase stores
 *   - REDIS_URL    → Redis cache adapter (cluster-shared JWT/OAuth caches)
 *                  + Redis subscription/purchase store
 *                  + Cache-backed webhook idempotency
 *                  + BullMQ webhook queue (durable retries + dead-letter)
 *
 * Usage:
 *   cp .env.example .env   # fill in your Apple/Google credentials
 *   npm install
 *   npm start              # http://localhost:4100
 */

import 'dotenv/config';
import express from 'express';
import {
  createOneSubMiddleware,
  PostgresSubscriptionStore,
  PostgresPurchaseStore,
  InMemorySubscriptionStore,
  InMemoryPurchaseStore,
  RedisSubscriptionStore,
  RedisPurchaseStore,
  RedisCacheAdapter,
  CacheWebhookEventStore,
  BullMQWebhookQueue,
} from '@onesub/server';

const app = express();
const port = parseInt(process.env.PORT || '4100', 10);

// ── Stores ───────────────────────────────────────────────────────────────────
// Pick by env var. The Postgres/Redis modules use dynamic imports so you only
// need the underlying npm package installed when the env var is set.
let store;
let purchaseStore;
let cache;
let webhookEventStore;
let webhookQueue;

if (process.env.REDIS_URL) {
  const { default: IORedis } = await import('ioredis');
  const redis = new IORedis(process.env.REDIS_URL, { maxRetriesPerRequest: null });
  cache = new RedisCacheAdapter(redis);
  webhookEventStore = new CacheWebhookEventStore(cache);
  webhookQueue = new BullMQWebhookQueue({ connection: redis });
  store = new RedisSubscriptionStore(redis);
  purchaseStore = new RedisPurchaseStore(redis);
  console.log('[onesub] Redis enabled — shared cache, idempotency, queue');
}

if (process.env.DATABASE_URL) {
  // Postgres takes precedence as the durable store of record. Redis stays as
  // the cache + queue layer above it.
  const subStore = new PostgresSubscriptionStore(process.env.DATABASE_URL);
  const pStore = new PostgresPurchaseStore(process.env.DATABASE_URL);
  await subStore.initSchema();
  await pStore.initSchema();
  store = subStore;
  purchaseStore = pStore;
  console.log('[onesub] Postgres enabled — durable subscription + purchase store');
}

if (!store) {
  store = new InMemorySubscriptionStore();
  purchaseStore = new InMemoryPurchaseStore();
  console.log('[onesub] In-memory stores (data lost on restart)');
}

// ── Mount onesub middleware ──────────────────────────────────────────────────
app.use(
  createOneSubMiddleware({
    apple: process.env.APPLE_BUNDLE_ID
      ? {
          bundleId: process.env.APPLE_BUNDLE_ID,
          sharedSecret: process.env.APPLE_SHARED_SECRET,
          keyId: process.env.APPLE_KEY_ID,
          issuerId: process.env.APPLE_ISSUER_ID,
          privateKey: process.env.APPLE_PRIVATE_KEY,
        }
      : undefined,
    google: process.env.GOOGLE_PACKAGE_NAME
      ? {
          packageName: process.env.GOOGLE_PACKAGE_NAME,
          serviceAccountKey: process.env.GOOGLE_SERVICE_ACCOUNT_KEY,
        }
      : undefined,
    database: { url: process.env.DATABASE_URL ?? '' },
    adminSecret: process.env.ADMIN_SECRET,
    store,
    purchaseStore,
    cache,
    webhookEventStore,
    webhookQueue,
  }),
);

// ── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    store: store.constructor.name,
    cache: cache?.constructor.name ?? 'in-memory',
    queue: webhookQueue?.constructor.name ?? 'in-process',
  });
});

// ── Start ────────────────────────────────────────────────────────────────────
app.listen(port, () => {
  console.log(`[onesub] Server listening on http://localhost:${port}`);
  console.log(`[onesub] Endpoints:`);
  console.log(`  POST http://localhost:${port}/onesub/validate`);
  console.log(`  GET  http://localhost:${port}/onesub/status?userId=USER_ID`);
  console.log(`  POST http://localhost:${port}/onesub/webhook/apple`);
  console.log(`  POST http://localhost:${port}/onesub/webhook/google`);
  if (process.env.ADMIN_SECRET && webhookQueue?.listDeadLetters) {
    console.log(`  GET  http://localhost:${port}/onesub/admin/webhook-deadletters  (X-Admin-Secret)`);
  }
});
