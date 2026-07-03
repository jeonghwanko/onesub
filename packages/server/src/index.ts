import express, { Router } from 'express';
import type { OneSubServerConfig } from '@onesub/shared';
import { DEFAULT_PORT } from '@onesub/shared';
import { InMemorySubscriptionStore, InMemoryPurchaseStore } from './store.js';
import type { SubscriptionStore, PurchaseStore } from './store.js';
import { createValidateRouter } from './routes/validate.js';
import { createStatusRouter } from './routes/status.js';
import { createWebhookRouter } from './routes/webhook.js';
import { createPurchaseRouter } from './routes/purchase.js';
import { createAdminRouter } from './routes/admin.js';
import { createEntitlementRouter } from './routes/entitlements.js';
import { createMetricsRouter } from './routes/metrics.js';
import { createAppleOfferRouter } from './routes/apple-offer.js';
import { setLogger } from './logger.js';
import type { CacheAdapter } from './cache.js';
import { setDefaultCache } from './cache.js';
import type { WebhookEventStore } from './webhook-events.js';
import type { WebhookQueue } from './webhook-queue.js';

/**
 * Extended config with optional pluggable stores.
 */
export interface OneSubMiddlewareConfig extends OneSubServerConfig {
  /**
   * Custom subscription store. Defaults to InMemorySubscriptionStore.
   * For production, provide a PostgreSQL or Redis backed implementation.
   */
  store?: SubscriptionStore;
  /**
   * Custom purchase store for consumables and non-consumables.
   * Defaults to InMemoryPurchaseStore.
   * For production, provide a PostgreSQL backed implementation.
   */
  purchaseStore?: PurchaseStore;
  /**
   * Cache backend for short-lived secrets (Apple JWT, Google OAuth token).
   * Default: in-memory, process-local. For multi-instance deployments pass a
   * `RedisCacheAdapter` so all nodes share a single mint per TTL window.
   */
  cache?: CacheAdapter;
  /**
   * Webhook idempotency store. Default: none (rely on Apple/Google retry +
   * downstream store PKs). For production strongly recommended — pass an
   * `InMemoryWebhookEventStore` (single instance) or `CacheWebhookEventStore`
   * backed by Redis (multi-instance) so duplicate notifications never apply
   * twice.
   */
  webhookEventStore?: WebhookEventStore;
  /**
   * Async webhook queue. Default: none — webhook routes process notifications
   * synchronously inside the request (route latency = handler latency;
   * Apple/Google source retries on 5xx are the durability layer).
   *
   * When set, the webhook routes keep the cheap gating inline (validation,
   * JWS/push-token verification, bundleId/packageName checks, idempotency
   * dedup) and `enqueue()` the decoded work, acking 200 as soon as the job is
   * accepted. The state-mutating processing runs in the queue handler, which
   * is registered once here at middleware creation via `setHandler()`.
   *
   * Pass a `BullMQWebhookQueue` for durable retries with backoff; jobs that
   * exhaust their attempts land in the dead-letter list, accessible via
   * `GET /onesub/admin/webhook-deadletters` and replayable via
   * `POST /onesub/admin/webhook-replay/:id` (requires `adminSecret`).
   */
  webhookQueue?: WebhookQueue;
}

/**
 * Create an Express Router with all OneSub routes mounted.
 *
 * Mount this in your existing Express app:
 * ```ts
 * import { createOneSubMiddleware } from '@onesub/server';
 * app.use(createOneSubMiddleware(config));
 * ```
 *
 * The routes registered are (all prefixed with nothing — mount at root or use
 * a prefix via `app.use('/prefix', createOneSubMiddleware(config))`):
 *
 *   POST /onesub/validate
 *   GET  /onesub/status
 *   POST /onesub/webhook/apple
 *   POST /onesub/webhook/google
 */
export function createOneSubMiddleware(config: OneSubMiddlewareConfig): Router {
  setLogger(config.logger);

  // Hard guard — mockMode accepts ANY receipt as valid. Letting this run on
  // a production server would be a fraud disaster. `skipJwsVerification` has
  // a similar shape but only degrades Apple signature checking; this one is
  // strictly worse, so the check is an error, not a warning.
  if ((config.apple?.mockMode || config.google?.mockMode) && process.env['NODE_ENV'] === 'production') {
    throw new Error(
      '[onesub] apple.mockMode / google.mockMode cannot be enabled when NODE_ENV=production — these modes accept any receipt as valid.',
    );
  }

  const store: SubscriptionStore = config.store ?? new InMemorySubscriptionStore();
  const purchaseStore: PurchaseStore = config.purchaseStore ?? new InMemoryPurchaseStore();

  // Swap the global cache adapter once when middleware is created. This is
  // the cheapest way to share a Redis-backed cache between all providers
  // without threading the adapter through every internal call site.
  if (config.cache) setDefaultCache(config.cache);

  const router = Router();

  // Parse JSON bodies for all OneSub routes (50 kb cap to prevent payload flooding)
  router.use(express.json({ limit: '50kb' }));

  router.use(createValidateRouter(config, store));
  router.use(createStatusRouter(store));
  router.use(createWebhookRouter(config, store, purchaseStore, config.webhookEventStore, config.webhookQueue));
  router.use(createPurchaseRouter(config, purchaseStore));

  // Admin routes — only mounted when config.adminSecret is set
  const adminRouter = createAdminRouter(config, purchaseStore, store, config.webhookQueue);
  if (adminRouter) router.use(adminRouter);

  // Entitlement routes — only mounted when config.entitlements is set
  const entitlementRouter = createEntitlementRouter(config, store, purchaseStore);
  if (entitlementRouter) router.use(entitlementRouter);

  // Metrics routes — only mounted when config.adminSecret is set (same gate
  // as admin routes; metrics expose aggregate operational data)
  const metricsRouter = createMetricsRouter(config, store, purchaseStore);
  if (metricsRouter) router.use(metricsRouter);

  // Apple Promotional Offer signing — only mounted when offerKeyId + offerPrivateKey are set
  const appleOfferRouter = createAppleOfferRouter(config);
  if (appleOfferRouter) router.use(appleOfferRouter);

  return router;
}

/**
 * Create a standalone Express application with all OneSub routes.
 *
 * ```ts
 * import { createOneSubServer } from '@onesub/server';
 * createOneSubServer(config).listen(4100);
 * ```
 */
export function createOneSubServer(config: OneSubMiddlewareConfig): ReturnType<typeof express> {
  const app = express();

  // Health check
  app.get('/health', (_req, res) => {
    res.json({ ok: true, service: 'onesub' });
  });

  app.use(createOneSubMiddleware(config));

  return app;
}

// Named re-exports for consumers who want to bring their own store
export { InMemorySubscriptionStore, InMemoryPurchaseStore } from './store.js';
export type { SubscriptionStore, PurchaseStore } from './store.js';
export { PostgresSubscriptionStore, PostgresPurchaseStore } from './stores/postgres.js';
export {
  RedisSubscriptionStore,
  RedisPurchaseStore,
  RedisCacheAdapter,
  RedisWebhookEventStore,
} from './stores/redis.js';

// Cache adapters
export type { CacheAdapter } from './cache.js';
export { InMemoryCacheAdapter, getDefaultCache, setDefaultCache } from './cache.js';

// Webhook hardening primitives
export type { WebhookEventStore } from './webhook-events.js';
export { InMemoryWebhookEventStore, CacheWebhookEventStore, unmarkWebhookEvent } from './webhook-events.js';
export type { WebhookQueue, WebhookJob, WebhookHandler, DeadLetterRecord } from './webhook-queue.js';
export { InProcessWebhookQueue, BullMQWebhookQueue } from './webhook-queue.js';
// Post-gate webhook processors — the same functions the built-in queue
// handler runs. Exported so hosts running a dedicated worker process (e.g.
// a standalone BullMQ Worker) can call `queue.setHandler(...)` themselves
// with identical processing semantics.
export { processAppleNotification } from './routes/webhook-apple.js';
export type { AppleWebhookWork } from './routes/webhook-apple.js';
export { processGoogleNotification } from './routes/webhook-google.js';
export type { GoogleWebhookWork } from './routes/webhook-google.js';

// OpenAPI document — for hosts that want to expose `/openapi.json` and
// generate clients from the spec.
export { ONESUB_OPENAPI, openapiHandler } from './openapi.js';
export type { OpenAPIDoc } from './openapi.js';

// OpenTelemetry helpers — exposed so host apps can wrap their own
// integrations in spans that inherit the same tracer config.
export { withSpan } from './tracing.js';

// Provider functions for direct (non-HTTP) usage
export {
  validateAppleReceipt,
  fetchAppleSubscriptionStatus,
  fetchAppleTransactionHistory,
  signApplePromotionalOffer,
} from './providers/apple.js';
export { validateGoogleReceipt } from './providers/google.js';

// Entitlement evaluator — exported so hosts can evaluate entitlements
// in-process (e.g. from non-HTTP background workers, custom routes).
export { evaluateEntitlement } from './routes/entitlements.js';

// Logger plumbing — expose so non-middleware callers (direct provider use)
// can still redirect logs.
export { setLogger, log } from './logger.js';

// Allow running directly: node dist/index.js
// Reads config from environment variables for quick local testing.
const isMain =
  typeof process !== 'undefined' &&
  process.argv[1] != null &&
  new URL(import.meta.url).pathname.endsWith(process.argv[1].replace(/\\/g, '/'));

if (isMain) {
  const config: OneSubMiddlewareConfig = {
    apple: process.env['APPLE_BUNDLE_ID']
      ? {
          bundleId: process.env['APPLE_BUNDLE_ID'],
          sharedSecret: process.env['APPLE_SHARED_SECRET'],
          keyId: process.env['APPLE_KEY_ID'],
          issuerId: process.env['APPLE_ISSUER_ID'],
          privateKey: process.env['APPLE_PRIVATE_KEY'],
        }
      : undefined,
    google: process.env['GOOGLE_PACKAGE_NAME']
      ? {
          packageName: process.env['GOOGLE_PACKAGE_NAME'],
          serviceAccountKey: process.env['GOOGLE_SERVICE_ACCOUNT_KEY'],
        }
      : undefined,
    database: {
      url: process.env['DATABASE_URL'] ?? '',
    },
    webhookSecret: process.env['WEBHOOK_SECRET'],
  };

  const port = process.env['PORT'] ? parseInt(process.env['PORT'], 10) : DEFAULT_PORT;

  createOneSubServer(config).listen(port, () => {
    console.log(`[onesub] Server listening on port ${port}`);
  });
}
