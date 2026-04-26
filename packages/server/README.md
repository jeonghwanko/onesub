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
  apple: {
    bundleId: 'com.yourapp.id',
    sharedSecret: process.env.APPLE_SHARED_SECRET,
    // Optional — required only for the App Store Server API features below
    // (status fetch fallback, consumption response).
    keyId: process.env.APPLE_KEY_ID,
    issuerId: process.env.APPLE_ISSUER_ID,
    privateKey: process.env.APPLE_PRIVATE_KEY,
  },
  google: { packageName: 'com.yourapp.id', serviceAccountKey: process.env.GOOGLE_SERVICE_ACCOUNT_KEY },
  database: { url: process.env.DATABASE_URL },
  store:         new PostgresSubscriptionStore(process.env.DATABASE_URL),
  purchaseStore: new PostgresPurchaseStore(process.env.DATABASE_URL),
  // Optional:
  adminSecret: process.env.ADMIN_SECRET,   // enables /onesub/purchase/admin/*
  logger: require('pino')(),               // any { info, warn, error } logger
  refundPolicy: 'immediate',               // 'immediate' (default) | 'until_expiry'
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

## Lifecycle states (`0.4.0+`)

`SubscriptionInfo.status` carries the full lifecycle. The status route's `active: boolean` is computed as `(active || grace_period) && expiresAt > now` — but the raw status lets you render accurate UX:

| Status | active | UX hint |
|--------|--------|---------|
| `active` | ✅ | normal |
| `grace_period` | ✅ | "결제 정보 확인 필요 (계속 사용 가능)" |
| `on_hold` | ❌ | "결제 정보를 업데이트하세요" |
| `paused` | ❌ | "재개 예정: \{autoResumeTime\}" |
| `expired` / `canceled` | ❌ | re-purchase or restore |

See [`@onesub/shared` README](../shared/README.md) for the full mapping.

## Refund policy (`0.8.0+`)

```ts
refundPolicy: 'immediate' | 'until_expiry'   // default 'immediate'
```

- `'immediate'` — subscription refunds (Apple `REFUND`/`REVOKE`, Google voided productType=1) flip status to `canceled` right away. Strict, fraud-resistant.
- `'until_expiry'` — keep `status`/`expiresAt` untouched, only flip `willRenew = false`. User keeps entitlement until the original expiry. Better UX for goodwill refunds.

IAP refunds (consumable / non-consumable) are **always immediate** regardless of policy — they have no expiry concept.

## Optional Apple App Store Server API features (`0.8.0+`)

Set `apple.keyId` / `apple.issuerId` / `apple.privateKey` (PKCS8 ES256 from App Store Connect → Users and Access → Keys) to unlock:

### Status API fallback (automatic)

If a webhook arrives for an `originalTransactionId` the store doesn't know (server downtime, queue truncation, fresh install), the webhook handler calls `GET /inApps/v1/subscriptions/{originalTransactionId}` to fetch canonical state from Apple and saves a record under a placeholder `userId`. Subsequent `/onesub/validate` from the host can claim ownership.

You can also call it directly:

```ts
import { fetchAppleSubscriptionStatus } from '@onesub/server';

const sub = await fetchAppleSubscriptionStatus(originalTxId, config.apple, { sandbox: false });
// sub: SubscriptionInfo | null  — null on missing creds / 404 / network failure
```

### CONSUMPTION_REQUEST response hook

When Apple sends a `CONSUMPTION_REQUEST` notification (consumable refund review), without a hook Apple has no usage signal and tends to grant the refund. Provide a hook to PUT consumption info back to `/inApps/v1/transactions/consumption/{txId}`:

```ts
apple: {
  // ...
  consumptionInfoProvider: async (ctx) => ({
    customerConsented: true,                  // required; false makes Apple ignore the response
    consumptionStatus: 3,                     // 0=undeclared, 1=not consumed, 2=partial, 3=full
    deliveryStatus: 1,                        // 0=undeclared, 1=delivered & working, 2=quality issue, ...
    refundPreference: 2,                      // 0=undeclared, 1=grant, 2=decline, 3=no preference
    // see AppleConsumptionRequest for the full set of optional fields
  }),
}
```

Fire-and-forget; failures are logged but don't block the webhook 200.

## Optional Google hooks (`0.8.0+`)

```ts
google: {
  // ...
  // Called when SUBSCRIPTION_PRICE_CHANGE_CONFIRMED (8) arrives — user agreed
  // to a price change; new price applies on next renewal. Useful for analytics.
  onPriceChangeConfirmed: async (ctx) => {
    await analytics.track('price_change_confirmed', ctx);
  },
}
```

## Schema

Canonical Postgres DDL shipped at [`sql/schema.sql`](./sql/schema.sql). Apply with `psql -f` or let `store.initSchema()` run it for you on startup.

`store.initSchema()` is **safe to call on every boot** — all DDL is `IF NOT EXISTS`. New columns added in later releases (e.g. `linked_purchase_token`, `auto_resume_time`) ship with `ALTER TABLE IF NOT EXISTS` so existing installs auto-backfill on the next startup.

## Security

- Apple JWS signature verified end-to-end against **Apple Root CA G3** (as of `0.6.0`)
- Google RTDN: `Authorization: Bearer` JWT verified against Google JWKS when `pushAudience` is configured
- `transactionId` ownership enforced — same receipt can't be reused across users (`0.5.0+`)
- zod input validation + 50 KB body cap
- Full write-up: [`docs/SECURITY.md`](../../docs/SECURITY.md)
- Error troubleshooting: [`docs/RECEIPT-ERRORS.md`](../../docs/RECEIPT-ERRORS.md)

## Links

- Repo: <https://github.com/jeonghwanko/onesub>
- Migration guide: [`docs/MIGRATION.md`](../../docs/MIGRATION.md)
- Changelog: [`CHANGELOG.md`](../../CHANGELOG.md)

MIT © onesub contributors.
