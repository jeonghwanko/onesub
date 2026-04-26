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
import { setLogger } from './logger.js';

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

  const router = Router();

  // Parse JSON bodies for all OneSub routes (50 kb cap to prevent payload flooding)
  router.use(express.json({ limit: '50kb' }));

  router.use(createValidateRouter(config, store));
  router.use(createStatusRouter(store));
  router.use(createWebhookRouter(config, store, purchaseStore));
  router.use(createPurchaseRouter(config, purchaseStore));

  // Admin routes — only mounted when config.adminSecret is set
  const adminRouter = createAdminRouter(config, purchaseStore);
  if (adminRouter) router.use(adminRouter);

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

// Provider functions for direct (non-HTTP) usage
export { validateAppleReceipt, fetchAppleSubscriptionStatus } from './providers/apple.js';
export { validateGoogleReceipt } from './providers/google.js';

// Logger plumbing — expose so non-middleware callers (direct provider use)
// can still redirect logs.
export { setLogger, log } from './logger.js';

// Default export: the middleware factory
export default createOneSubMiddleware;

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
