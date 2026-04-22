<p align="center">
  <a href="https://www.npmjs.com/package/@onesub/server"><img src="https://img.shields.io/npm/v/@onesub/server.svg?label=%40onesub%2Fserver" alt="@onesub/server" /></a>
  <a href="https://www.npmjs.com/package/@onesub/sdk"><img src="https://img.shields.io/npm/v/@onesub/sdk.svg?label=%40onesub%2Fsdk" alt="@onesub/sdk" /></a>
  <a href="https://www.npmjs.com/package/@onesub/mcp-server"><img src="https://img.shields.io/npm/v/@onesub/mcp-server.svg?label=%40onesub%2Fmcp-server" alt="@onesub/mcp-server" /></a>
  <br/>
  <img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License" />
  <img src="https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg" alt="Node >= 20" />
  <img src="https://img.shields.io/badge/platform-iOS%20%7C%20Android-lightgrey.svg" alt="Platform" />
</p>

<h1 align="center">onesub</h1>

<p align="center">
  <strong>Server-side receipt validation for react-native-iap. One line.</strong>
</p>

<p align="center">
  react-native-iap handles the purchase.<br/>
  onesub handles everything after — validation, webhooks, subscription state.<br/>
  Open source. Self-hosted. Zero revenue share.
</p>

---

## The Problem

You use `react-native-iap` to handle purchases. But then you need a server to:

- Verify Apple StoreKit 2 receipts (JWS signature validation)
- Verify Google Play receipts (Play Developer API v3)
- Handle webhooks (renewals, cancellations, refunds)
- Track subscription state in a database
- Track one-time purchases (consumables + non-consumables)
- Expose "is this user subscribed?" and "what did this user buy?" endpoints

**That's 2-3 weeks of work.** Or one line:

```ts
app.use(createOneSubMiddleware(config));
```

---

## How It Works

```
react-native-iap (client)            @onesub/server (your backend)
                                      ┌─────────────────────────────────┐
Subscriptions:                        │                                 │
  requestSubscription() ──receipt───▶ │ POST /onesub/validate           │
  fetch('/onesub/status') ──────────▶ │ GET  /onesub/status             │
                                      │                                 │
One-time purchases:                   │                                 │
  requestPurchase() ────receipt───▶   │ POST /onesub/purchase/validate  │
  fetch('/onesub/purchase/status') ──▶│ GET  /onesub/purchase/status    │
                                      │                                 │
Webhooks (auto):                      │ POST /onesub/webhook/apple      │
                                      │ POST /onesub/webhook/google     │
                                      └─────────────────────────────────┘
```

---

## Quick Start

### 1. Install

```bash
npm install @onesub/server
```

### 2. Add to your Express app

```ts
import { createOneSubMiddleware, PostgresSubscriptionStore } from '@onesub/server';

app.use(createOneSubMiddleware({
  apple: {
    bundleId: 'com.yourapp.id',
    sharedSecret: process.env.APPLE_SHARED_SECRET,
  },
  google: {
    packageName: 'com.yourapp.id',
    serviceAccountKey: process.env.GOOGLE_SERVICE_ACCOUNT_KEY,
  },
  database: { url: process.env.DATABASE_URL },
  store: new PostgresSubscriptionStore(process.env.DATABASE_URL),
}));
```

### 3. Check subscription from your app

```ts
const res = await fetch('https://api.yourapp.com/onesub/status?userId=user123');
const { active } = await res.json();
// active: true → subscribed, false → not subscribed
```

**Done.** Apple/Google receipt validation, webhooks, and subscription tracking — all handled.

---

## What You Get

### Subscriptions (auto-renewable)

| Endpoint | What it does |
|----------|-------------|
| `POST /onesub/validate` | Verify receipt, save subscription |
| `GET /onesub/status?userId=` | Check if user has active subscription |
| `POST /onesub/webhook/apple` | Handle App Store Server Notifications V2 |
| `POST /onesub/webhook/google` | Handle Google Real-Time Developer Notifications |

### One-time Purchases (consumable + non-consumable)

| Endpoint | What it does |
|----------|-------------|
| `POST /onesub/purchase/validate` | Verify receipt, save purchase. Response includes `action: 'new' \| 'restored'` so the client can distinguish a first-time purchase from an idempotent replay or reinstall-triggered reassignment. |
| `GET /onesub/purchase/status?userId=` | List user's purchases |

### Admin (opt-in — requires `config.adminSecret`)

Mounted only when `config.adminSecret` is set. All requests must include the `X-Admin-Secret` header.

| Endpoint | What it does |
|----------|-------------|
| `DELETE /onesub/purchase/admin/:userId/:productId` | Wipe a non-consumable so the user can re-test the purchase flow |
| `POST /onesub/purchase/admin/grant` | Manually insert a purchase record (bypasses store verification) |
| `POST /onesub/purchase/admin/transfer` | Reassign a `transactionId` to a new `userId` (legitimate device/account migration) |

**Consumables** (coins, credits): Can be purchased multiple times. Each purchase is tracked.

**Non-consumables** (unlock premium, remove ads): Purchased once. Duplicate purchases are rejected with `409 NON_CONSUMABLE_ALREADY_OWNED`.

```ts
// Validate a consumable purchase
const res = await fetch('https://api.yourapp.com/onesub/purchase/validate', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    platform: 'apple',
    receipt: transactionReceipt,
    userId: 'user123',
    productId: 'credits_100',
    type: 'consumable',    // or 'non_consumable'
  }),
});
const { valid, purchase } = await res.json();
```

## What's Under the Hood

- **Apple**: JWS signature verified against Apple JWKS (not just decoded)
- **Google**: OAuth2 service account → Play Developer API v3, token cached
- **Webhooks**: Auto-handle renewals, cancellations, expirations, refunds
- **Storage**: Pluggable `SubscriptionStore` — built-in PostgreSQL + in-memory
- **Validation**: zod input validation, 50KB body limit, userId length checks
- **Security**: [Full details →](docs/SECURITY.md)
- **Troubleshooting**: [errorCode → cause → fix](docs/RECEIPT-ERRORS.md)

---

## Optional: React Native SDK

If you want a drop-in React hook + paywall component (built on react-native-iap):

```bash
npm install @onesub/sdk react-native-iap
```

```tsx
import { OneSubProvider, useOneSub } from '@onesub/sdk';

// Wrap your app
<OneSubProvider config={{ serverUrl, productId }} userId={userId}>
  <App />
</OneSubProvider>

// Subscriptions
const { isActive, subscribe, restore } = useOneSub();

// One-time products (consumable / non-consumable)
const { purchaseProduct, restoreProduct } = useOneSub();

// Purchase a consumable (e.g. coins)
const purchase = await purchaseProduct('credits_100', 'consumable');
// purchase is null if user cancelled, PurchaseInfo (+ action) on success

// Purchase a non-consumable (e.g. premium unlock)
const purchase = await purchaseProduct('premium_unlock', 'non_consumable');
if (purchase?.action === 'restored') {
  // already owned — show "복원 완료" instead of "구매 완료"
}

// Restore a non-consumable from the store's purchase history
const restored = await restoreProduct('premium_unlock', 'non_consumable');
```

**Mock mode** — set `config.mockMode: true` to return synthetic success from `subscribe` / `restore` / `purchaseProduct` / `restoreProduct` without calling `react-native-iap` or the onesub server. Useful for running UI flows in Expo Go / the simulator. Never enable in production.

**Peer dependency:** SDK requires `react-native-iap` **v15+** (event-based purchase flow).

The SDK is optional. You can use `@onesub/server` with any client — React Native, Flutter, or plain HTTP calls.

---

## Optional: MCP Server (AI Integration)

For Claude Code / Cursor users — AI helps set up your subscription:

```json
{ "mcpServers": { "onesub": { "command": "npx", "args": ["@onesub/mcp-server"] } } }
```

> "Add a monthly subscription to my Expo app"

### Skill document for AI agents

A single-file integration guide optimized for LLM ingestion lives at [`SKILL.md`](SKILL.md). Point Claude / Cursor / any agent at it for complete onesub context:

> Read `https://raw.githubusercontent.com/jeonghwanko/onesub/master/SKILL.md` then integrate onesub into this project.

---

## Packages

| Package | Version | What | Install |
|---------|---------|------|---------|
| [`@onesub/server`](https://www.npmjs.com/package/@onesub/server) | ![npm](https://img.shields.io/npm/v/@onesub/server.svg) | Express middleware — receipt validation + webhooks | `npm i @onesub/server` |
| [`@onesub/sdk`](https://www.npmjs.com/package/@onesub/sdk) | ![npm](https://img.shields.io/npm/v/@onesub/sdk.svg) | React Native SDK — `useOneSub()` + `<Paywall />` | `npm i @onesub/sdk` |
| [`@onesub/mcp-server`](https://www.npmjs.com/package/@onesub/mcp-server) | ![npm](https://img.shields.io/npm/v/@onesub/mcp-server.svg) | MCP tools — AI creates products + paywalls | `npx @onesub/mcp-server` |
| [`@onesub/cli`](https://www.npmjs.com/package/@onesub/cli) | ![npm](https://img.shields.io/npm/v/@onesub/cli.svg) | Scaffolds a starter server project | `npx @onesub/cli init` |
| [`@onesub/shared`](https://www.npmjs.com/package/@onesub/shared) | ![npm](https://img.shields.io/npm/v/@onesub/shared.svg) | Shared TypeScript types | Auto-installed |

---

## vs RevenueCat

| | RevenueCat | onesub |
|---|---|---|
| Receipt validation | Their servers | **Your server** |
| Revenue share | 1% after $2.5K | **0% forever** |
| Data ownership | Their database | **Your database** |
| Vendor lock-in | Yes | **No (MIT open source)** |
| Dashboard | Yes | Not yet |
| Setup time | 2-3 hours | **10 minutes** |

**onesub is not a RevenueCat replacement.** RevenueCat offers analytics, experiments, and a dashboard. onesub is for developers who want to own their subscription infrastructure.

Already on RevenueCat and curious? See [`docs/MIGRATE-FROM-REVENUECAT.md`](docs/MIGRATE-FROM-REVENUECAT.md) — a step-by-step guide covering client code, historical data, webhook switchover, and rollback.

---

## Examples

Working examples to get you started in minutes:

| Example | What | Run |
|---------|------|-----|
| [`examples/server`](examples/server) | Express server with receipt validation | `npm start` |
| [`examples/expo-app`](examples/expo-app) | Expo Router app with paywall | `npx expo start` |

```bash
# 1. Start the server
cd examples/server
cp .env.example .env   # add your Apple/Google credentials
npm install && npm start

# ── or, full stack (server + Postgres) in one command ──
docker compose up      # http://localhost:4100

# 2. Start the app (in another terminal)
cd examples/expo-app
npm install && npx expo start
```

---

## Custom Store

Built-in PostgreSQL store, or bring your own:

```ts
import { SubscriptionStore } from '@onesub/server';

class RedisStore implements SubscriptionStore {
  async save(sub) { /* ... */ }
  async getByUserId(userId) { /* ... */ }
  async getByTransactionId(txId) { /* ... */ }
}

app.use(createOneSubMiddleware({ ...config, store: new RedisStore() }));
```

The canonical Postgres schema is shipped with the package at
[`packages/server/sql/schema.sql`](packages/server/sql/schema.sql). Apply it
with `psql -f` if you manage migrations externally, or let `store.initSchema()`
run it for you on startup.

---

## Roadmap

- [x] Apple StoreKit 2 receipt validation (JWKS verified)
- [x] Google Play Billing v3 receipt validation
- [x] Webhook handlers (Apple V2 + Google RTDN)
- [x] PostgreSQL subscription store
- [x] React Native SDK + paywall components
- [x] MCP server for AI-assisted setup
- [x] Security hardening (zod validation, body limits, signature verification)
- [x] CLI scaffolding (`npx @onesub/cli init`)
- [ ] Analytics dashboard
- [ ] Hosted service (no server needed)

---

## Contributing

```bash
git clone https://github.com/jeonghwanko/onesub.git
cd onesub && npm install && npm run build && npm test
```

See [CLAUDE.md](CLAUDE.md) for architecture and conventions.

---

## License

[MIT](LICENSE)

---

<p align="center">
  <strong>react-native-iap</strong> handles the purchase.<br/>
  <strong>onesub</strong> handles everything after.
</p>
