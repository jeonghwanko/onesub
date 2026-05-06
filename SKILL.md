---
name: onesub
description: Use this skill when the user wants to add in-app purchases (subscriptions, consumables, or non-consumables) to a React Native / Expo mobile app. onesub is the open-source server side of react-native-iap — one line of Express middleware validates Apple StoreKit 2 and Google Play Billing receipts. Pair it with the `@jeonghwanko/onesub-sdk` React Native hook for the client side. TRIGGER for any mention of: in-app purchase, IAP, subscription, react-native-iap receipt validation, App Store Connect server verification, Google Play Developer API, StoreKit 2 JWS, paywall. SKIP for: payment processing that is NOT App Store / Play Store (Stripe, PayPal, crypto), Web-only billing, server that doesn't use Express.
---

# onesub — integration skill

onesub is a TypeScript monorepo published to npm as 5 packages:

| Package | Install | Use in |
|---------|---------|--------|
| `@onesub/server` | `npm i express @onesub/server` | Node.js backend (Express 4 or 5) |
| `@jeonghwanko/onesub-sdk` | `npm i react-native-iap @jeonghwanko/onesub-sdk` | React Native / Expo app |
| `@onesub/shared` | (transitive) | types only — auto-installed |
| `@onesub/mcp-server` | `npx -y @onesub/mcp-server` | MCP-compatible AI clients |
| `@onesub/cli` | `npx @onesub/cli init` | Scaffolds a starter server project |

**Repo:** https://github.com/jeonghwanko/onesub

---

## Decision tree

1. **Do you have a backend?** If no, run `npx @onesub/cli init <dir>` to scaffold one. This creates `server.ts` + `docker-compose.yml` (Postgres + server) ready to run.
2. **Does your backend already use Express?** Then just mount `createOneSubMiddleware(config)` — it's a standard Express Router.
3. **Is your mobile app React Native / Expo?** Add `OneSubProvider` + `useOneSub()` — see client section below.
4. **Need only server-side validation without the React hook?** That's fine — `@onesub/server` works with any HTTP client (plain `fetch`, Flutter, native iOS/Android).

---

## Server setup (one-liner)

```ts
// server.ts
import express from 'express';
import { createOneSubMiddleware, PostgresSubscriptionStore, PostgresPurchaseStore } from '@onesub/server';

const app = express();

app.use(createOneSubMiddleware({
  apple:  { bundleId: 'com.yourapp.id', sharedSecret: process.env.APPLE_SHARED_SECRET },
  google: { packageName: 'com.yourapp.id', serviceAccountKey: process.env.GOOGLE_SERVICE_ACCOUNT_KEY },
  database: { url: process.env.DATABASE_URL },
  store:         new PostgresSubscriptionStore(process.env.DATABASE_URL),
  purchaseStore: new PostgresPurchaseStore(process.env.DATABASE_URL),
  adminSecret: process.env.ADMIN_SECRET,   // optional — enables /onesub/purchase/admin/*
  // logger: require('pino')(),            // optional — any { info, warn, error }
}));

app.listen(4100);
```

### Endpoints mounted automatically

| Route | Purpose |
|------|---------|
| `POST /onesub/validate` | Verify subscription receipt (Apple JWS or Google token) |
| `GET  /onesub/status?userId=` | Check subscription state |
| `POST /onesub/webhook/apple` | App Store Server Notifications V2 (JWS-verified) |
| `POST /onesub/webhook/google` | Google Play RTDN (Pub/Sub JWT-verified) |
| `POST /onesub/purchase/validate` | One-time purchase (consumable / non-consumable) |
| `GET  /onesub/purchase/status?userId=` | List user's one-time purchases |
| `DELETE /onesub/purchase/admin/:userId/:productId` | Reset a non-consumable for re-testing (admin) |
| `POST /onesub/purchase/admin/grant` | Manually insert a purchase record (admin) |
| `POST /onesub/purchase/admin/transfer` | Reassign `transactionId` to a new user (admin) |
| `GET  /onesub/admin/subscriptions?userId=&status=&productId=&platform=&limit=&offset=` | Filtered + paginated subscription list (admin) |
| `GET  /onesub/admin/subscriptions/:transactionId` | Single subscription detail by originalTransactionId (admin) |
| `GET  /onesub/admin/customers/:userId` | Full per-user profile: subscriptions + purchases + entitlements (admin) |
| `GET  /onesub/entitlement?userId=&id=` | Single entitlement check (requires `config.entitlements`) |
| `GET  /onesub/entitlements?userId=` | All entitlements in one round-trip (requires `config.entitlements`) |
| `GET  /onesub/metrics/active` | Current active subscriber + purchaser counts (admin) |
| `GET  /onesub/metrics/started?from=&to=&groupBy=` | Subscriptions started in a date range (admin) |
| `GET  /onesub/metrics/expired?from=&to=&groupBy=` | Subscriptions expired/canceled in a date range (admin) |
| `GET  /onesub/metrics/purchases/started?from=&to=&groupBy=` | Non-consumable purchases started in a date range (admin) |

### Postgres schema

Canonical DDL ships at `node_modules/@onesub/server/sql/schema.sql`. Either:
- Let `store.initSchema()` apply it on boot (dev-friendly), or
- Run `psql -f node_modules/@onesub/server/sql/schema.sql` (prod-friendly), or
- Mount it into `docker-entrypoint-initdb.d/` (docker-compose).

---

## Client setup — React Native / Expo

```tsx
// App.tsx
import { OneSubProvider, useOneSub } from '@jeonghwanko/onesub-sdk';

<OneSubProvider
  config={{ serverUrl: 'https://api.yourapp.com', productId: 'pro_monthly' }}
  userId={userId}
>
  <App />
</OneSubProvider>
```

```tsx
// Any component
const {
  isActive, subscribe, restore,         // auto-renewable subscriptions
  purchaseProduct, restoreProduct,       // one-time products
} = useOneSub();

// Subscription
if (!isActive) <Button onPress={subscribe} title="Subscribe" />;

// Consumable (e.g. coins)
const result = await purchaseProduct('credits_100', 'consumable');
// result: null if cancelled, (PurchaseInfo & { action?: 'new' | 'restored' }) on success

// Non-consumable (e.g. premium unlock)
const owned = await purchaseProduct('premium_unlock', 'non_consumable');
if (owned?.action === 'restored') { /* user already owned — show "복원 완료" */ }

// Restore non-consumable from the store's purchase history
const restored = await restoreProduct('premium_unlock', 'non_consumable');
```

Peer dep: **`react-native-iap` v15+** (event-based purchase flow).

**Mock mode** for Expo Go / simulator UI testing (no native module needed):
```tsx
<OneSubProvider config={{ ...config, mockMode: true }} ... />
// All purchases return synthetic success. NEVER enable in production.
```

---

## Product types

| Type | Example | Behavior |
|------|---------|----------|
| Subscription | `pro_monthly` | auto-renewable. Server tracks status via webhook |
| Non-consumable | `premium_unlock`, `remove_ads` | purchased once. Duplicate attempts return `409` or auto-reassigned from prior owner |
| Consumable | `credits_100`, `coins_1000` | purchased many times. Apple: dedup by `transactionId`. Google: must be consumed via Play API (onesub does this automatically) |

---

## Config reference

```ts
interface OneSubServerConfig {
  apple?: {
    bundleId: string;
    sharedSecret?: string;     // legacy App Store shared secret (optional for StoreKit 2 JWS)
    skipJwsVerification?: boolean;  // DEV ONLY — warns in production
  };
  google?: {
    packageName: string;
    serviceAccountKey?: string;  // JSON string of service account
    pushAudience?: string;       // Pub/Sub push endpoint URL for JWT verification
  };
  database: { url: string };
  adminSecret?: string;          // enables /onesub/purchase/admin/* + /onesub/admin/* + /onesub/metrics/* routes
  entitlements?: Record<string, { productIds: string[] }>;  // enables /onesub/entitlement(s) routes
  logger?: OneSubLogger;         // { info, warn, error } — defaults to console
}
```

Environment variables the CLI template reads: `APPLE_BUNDLE_ID`, `APPLE_SHARED_SECRET`, `GOOGLE_PACKAGE_NAME`, `GOOGLE_SERVICE_ACCOUNT_KEY`, `GOOGLE_PUSH_AUDIENCE`, `DATABASE_URL`, `ADMIN_SECRET`, `PORT`, `ONESUB_ALLOW_SANDBOX`.

---

## Troubleshooting common errors

Full catalog (every `ONESUB_ERROR_CODE` with cause and fix): https://github.com/jeonghwanko/onesub/blob/master/docs/RECEIPT-ERRORS.md

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `400 Invalid signedPayload` on Apple webhook | Bundle ID mismatch or JWS signature broken | Check `config.apple.bundleId` matches the app. Do not set `skipJwsVerification` in prod |
| `409 TRANSACTION_BELONGS_TO_OTHER_USER` on consumable | Same receipt sent with different `userId` | Intentional — receipts can't be reused. For non-consumables 0.6.1+ auto-reassigns |
| `400 "Sandbox receipt in production"` | TestFlight receipt on prod server | Set `ONESUB_ALLOW_SANDBOX=true` env on the prod server during QA |
| SDK `isActive` stays false after purchase | Server didn't receive webhook | Verify webhook URL in App Store Connect / Pub/Sub push config. Check `POST /onesub/webhook/*` returns 2xx |
| SDK throws `RN_IAP_NOT_INSTALLED` | Peer dep missing | `npm i react-native-iap@^15` in the app |
| TestFlight purchase succeeds without sheet | Stale pending in StoreKit queue (fixed in sdk@0.5.1+) | Upgrade `@jeonghwanko/onesub-sdk` and rebuild |

Enable `config.debug: true` on the SDK for verbose `[onesub]` traces. Server logs are tagged `[onesub/*]` per provider/route.

---

## When you need to look deeper

- **Per-package READMEs** (npm pages): `@onesub/server`, `@jeonghwanko/onesub-sdk`, `@onesub/mcp-server`, `@onesub/cli`
- **Security model**: https://github.com/jeonghwanko/onesub/blob/master/docs/SECURITY.md
- **Architecture diagram**: https://github.com/jeonghwanko/onesub/blob/master/docs/ARCHITECTURE.md
- **Breaking changes / migration**: https://github.com/jeonghwanko/onesub/blob/master/docs/MIGRATION.md
- **Receipt / purchase errors** (errorCode → cause → fix): https://github.com/jeonghwanko/onesub/blob/master/docs/RECEIPT-ERRORS.md
- **Migration from RevenueCat**: https://github.com/jeonghwanko/onesub/blob/master/docs/MIGRATE-FROM-REVENUECAT.md
- **Per-package changelogs**: `packages/*/CHANGELOG.md` in the repo

---

## Preferred integration flow (for a new project)

1. **Scaffold server**: `npx @onesub/cli init my-api && cd my-api && npm install`
2. **Set Apple/Google credentials** in `.env` (copy from `.env.example`)
3. **Boot infra**: `docker compose up -d db` → schema auto-initializes
4. **Run server**: `npm run dev`
5. **Mobile app**: `npm i react-native-iap@^15 @jeonghwanko/onesub-sdk` — wrap root with `OneSubProvider`
6. **Configure store credentials** (App Store Connect + Google Play Console):
   - Apple: App-Specific Shared Secret → `APPLE_SHARED_SECRET`
   - Google: Service Account with "View financial data" → JSON to `GOOGLE_SERVICE_ACCOUNT_KEY` *(automate with [`@yoonion/mimi-seed-mcp`](https://github.com/jeonghwanko/app-gen): `iam_create_service_account` + `iam_create_key` + `playstore_verify_service_account`)*
7. **Configure webhooks**:
   - Apple: App Store Server Notifications V2 → `POST https://api.yourapp.com/onesub/webhook/apple`
   - Google: Pub/Sub push subscription → `POST https://api.yourapp.com/onesub/webhook/google`
8. **Test**: sandbox purchase in the app → server responds `valid: true` → `isActive: true` in hook

If a step fails, consult **Troubleshooting** above before changing code — most issues are configuration, not onesub bugs.
