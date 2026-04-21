import 'dotenv/config';
import express from 'express';
import {
  createOneSubMiddleware,
  InMemorySubscriptionStore,
  InMemoryPurchaseStore,
  PostgresSubscriptionStore,
  PostgresPurchaseStore,
} from '@onesub/server';

const app = express();
const port = parseInt(process.env.PORT ?? '4100', 10);

// Pick stores based on whether DATABASE_URL is set.
const dbUrl = process.env.DATABASE_URL;
const store = dbUrl ? new PostgresSubscriptionStore(dbUrl) : new InMemorySubscriptionStore();
const purchaseStore = dbUrl ? new PostgresPurchaseStore(dbUrl) : new InMemoryPurchaseStore();

if (store instanceof PostgresSubscriptionStore) await store.initSchema();
if (purchaseStore instanceof PostgresPurchaseStore) await purchaseStore.initSchema();

app.use(
  createOneSubMiddleware({
    apple: process.env.APPLE_BUNDLE_ID
      ? { bundleId: process.env.APPLE_BUNDLE_ID, sharedSecret: process.env.APPLE_SHARED_SECRET }
      : undefined,
    google: process.env.GOOGLE_PACKAGE_NAME
      ? {
          packageName: process.env.GOOGLE_PACKAGE_NAME,
          serviceAccountKey: process.env.GOOGLE_SERVICE_ACCOUNT_KEY,
          pushAudience: process.env.GOOGLE_PUSH_AUDIENCE,
        }
      : undefined,
    database: { url: dbUrl ?? '' },
    store,
    purchaseStore,
    adminSecret: process.env.ADMIN_SECRET,
  }),
);

app.get('/health', (_req, res) => res.json({ ok: true }));

app.listen(port, () => {
  console.log(`[onesub] listening on http://localhost:${port}`);
});
