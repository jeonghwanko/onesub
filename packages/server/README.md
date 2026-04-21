# @onesub/server

Express middleware for Apple StoreKit 2 + Google Play Billing receipt validation, webhooks, and subscription/purchase storage. One line to mount.

```bash
npm install @onesub/server
```

## Requirements

- Node.js **>= 20**
- **Express** as a peer dependency — `^4.17.0 || ^5.0.0`. Install in your app:
  ```bash
  npm install @onesub/server express
  ```
- PostgreSQL **12+** (optional, for production stores)

## Quick start

```ts
import express from 'express';
import { createOneSubMiddleware, PostgresSubscriptionStore, PostgresPurchaseStore } from '@onesub/server';

const app = express();

app.use(createOneSubMiddleware({
  apple:  { bundleId: 'com.yourapp.id', sharedSecret: process.env.APPLE_SHARED_SECRET },
  google: { packageName: 'com.yourapp.id', serviceAccountKey: process.env.GOOGLE_SERVICE_ACCOUNT_KEY },
  database: { url: process.env.DATABASE_URL },
  store:         new PostgresSubscriptionStore(process.env.DATABASE_URL),
  purchaseStore: new PostgresPurchaseStore(process.env.DATABASE_URL),
  // Optional:
  adminSecret: process.env.ADMIN_SECRET,   // enables /onesub/purchase/admin/*
  logger: require('pino')(),               // any { info, warn, error } logger
}));

app.listen(4100);
```

## Endpoints

| Route | Purpose |
|------|---------|
| `POST /onesub/validate` | Verify Apple/Google subscription receipt |
| `GET  /onesub/status?userId=` | Check subscription state |
| `POST /onesub/webhook/apple` | App Store Server Notifications V2 |
| `POST /onesub/webhook/google` | Google Play RTDN (Pub/Sub push) |
| `POST /onesub/purchase/validate` | Verify one-time purchase (consumable / non-consumable) |
| `GET  /onesub/purchase/status?userId=` | List user's one-time purchases |
| `DELETE /onesub/purchase/admin/:userId/:productId` | Wipe a non-consumable (requires `adminSecret`) |
| `POST /onesub/purchase/admin/grant` | Manually grant a purchase (requires `adminSecret`) |
| `POST /onesub/purchase/admin/transfer` | Reassign a `transactionId` to a new `userId` (requires `adminSecret`) |

## Schema

Canonical Postgres DDL shipped at [`sql/schema.sql`](./sql/schema.sql). Apply with `psql -f` or let `store.initSchema()` run it for you on startup.

## Security

- Apple JWS signature verified end-to-end against **Apple Root CA G3** (as of `0.6.0`)
- Google RTDN: `Authorization: Bearer` JWT verified against Google JWKS when `pushAudience` is configured
- `transactionId` ownership enforced — same receipt can't be reused across users (`0.5.0+`)
- zod input validation + 50 KB body cap
- Full write-up: [`docs/SECURITY.md`](../../docs/SECURITY.md)

## Links

- Repo: <https://github.com/jeonghwanko/onesub>
- Migration guide: [`docs/MIGRATION.md`](../../docs/MIGRATION.md)
- Changelog: [`CHANGELOG.md`](../../CHANGELOG.md)

MIT © onesub contributors.
