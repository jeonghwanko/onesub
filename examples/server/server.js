/**
 * onesub server example — minimal Express app with receipt validation.
 *
 * Usage:
 *   cp .env.example .env   # fill in your Apple/Google credentials
 *   npm install
 *   npm start              # http://localhost:4100
 *
 * Endpoints created automatically:
 *   POST /onesub/validate          — verify Apple/Google receipt
 *   GET  /onesub/status?userId=    — check subscription status
 *   POST /onesub/webhook/apple     — App Store Server Notifications V2
 *   POST /onesub/webhook/google    — Google Real-Time Developer Notifications
 *   GET  /health                   — health check
 */

import 'dotenv/config';
import express from 'express';
import {
  createOneSubMiddleware,
  PostgresSubscriptionStore,
  InMemorySubscriptionStore,
} from '@onesub/server';

const app = express();
const port = parseInt(process.env.PORT || '4100', 10);

// ── Choose a subscription store ──────────────────────────────────────────────
// PostgreSQL for production, in-memory for development
const store = process.env.DATABASE_URL
  ? new PostgresSubscriptionStore(process.env.DATABASE_URL)
  : new InMemorySubscriptionStore();

if (store instanceof PostgresSubscriptionStore) {
  await store.initSchema(); // creates table if not exists
  console.log('[onesub] Using PostgreSQL store');
} else {
  console.log('[onesub] Using in-memory store (data lost on restart)');
}

// ── Mount onesub middleware ──────────────────────────────────────────────────
app.use(
  createOneSubMiddleware({
    apple: process.env.APPLE_BUNDLE_ID
      ? {
          bundleId: process.env.APPLE_BUNDLE_ID,
          sharedSecret: process.env.APPLE_SHARED_SECRET,
        }
      : undefined,
    google: process.env.GOOGLE_PACKAGE_NAME
      ? {
          packageName: process.env.GOOGLE_PACKAGE_NAME,
          serviceAccountKey: process.env.GOOGLE_SERVICE_ACCOUNT_KEY,
        }
      : undefined,
    database: { url: process.env.DATABASE_URL ?? '' },
    store,
  }),
);

// ── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', store: store.constructor.name });
});

// ── Your own routes go here ──────────────────────────────────────────────────
// app.get('/api/premium-content', requireAuth, (req, res) => { ... });

// ── Start ────────────────────────────────────────────────────────────────────
app.listen(port, () => {
  console.log(`[onesub] Server listening on http://localhost:${port}`);
  console.log(`[onesub] Endpoints:`);
  console.log(`  POST http://localhost:${port}/onesub/validate`);
  console.log(`  GET  http://localhost:${port}/onesub/status?userId=USER_ID`);
  console.log(`  POST http://localhost:${port}/onesub/webhook/apple`);
  console.log(`  POST http://localhost:${port}/onesub/webhook/google`);
});
