# Configuration Reference

This guide explains the configuration surfaces shared by the server, React Native SDK, CLI template,
dashboard, and multi-app runtime. TypeScript types remain the source of truth in
`packages/shared/src/types.ts` and `packages/server/src/index.ts`.

## Server Configuration Layers

`createOneSubMiddleware()` accepts `OneSubMiddlewareConfig`, which extends `OneSubServerConfig` with
pluggable storage, cache, idempotency, and queue components.

```ts
import {
  createOneSubMiddleware,
  PostgresSubscriptionStore,
  PostgresPurchaseStore,
} from '@onesub/server';

const databaseUrl = process.env.DATABASE_URL!;

app.use(createOneSubMiddleware({
  apple: { bundleId: 'com.example.app' },
  google: {
    packageName: 'com.example.app',
    serviceAccountKey: process.env.GOOGLE_SERVICE_ACCOUNT_KEY,
  },
  database: { url: databaseUrl },
  store: new PostgresSubscriptionStore(databaseUrl),
  purchaseStore: new PostgresPurchaseStore(databaseUrl),
  adminSecret: process.env.ADMIN_SECRET,
}));
```

Important: `database.url` does not construct or select a store. Pass `store` and `purchaseStore`
explicitly. Without them, middleware uses in-memory stores even when `database.url` is populated.

## Top-Level Server Options

| Option | Required | Default/activation | Purpose |
|---|---|---|---|
| `database.url` | Type-required | No automatic connection | Compatibility/config metadata; construct durable stores separately |
| `apple` | One provider normally | Disabled | Apple validation and webhooks for the default app |
| `google` | One provider normally | Disabled | Google validation and RTDN for the default app |
| `apps` | No | Single-app mode | Credentials for multiple isolated applications |
| `defaultAppId` | No | Top-level app or only configured app | Fallback app when a request cannot identify one |
| `adminSecret` | No | Admin/metrics routes not mounted | Protects admin, customer, metrics, sync, and dead-letter routes |
| `entitlements` | No | Entitlement routes not mounted | Maps stable entitlement IDs to product IDs |
| `refundPolicy` | No | `immediate` | Subscription refund access policy |
| `logger` | No | `console` | `{ info, warn, error }` server log sink |
| `webhookSecret` | No | No current Apple/Google enforcement | Legacy/reserved field; do not use it as webhook authentication |

Apple uses signed JWS payloads. Google push authentication is configured with `pushAudience` and
`pushServiceAccountEmail` rather than `webhookSecret`.

## Apple Options

| Option | Required | Purpose |
|---|---|---|
| `bundleId` | Yes when Apple is enabled | Expected bundle ID and multi-app identity |
| `sharedSecret` | No for StoreKit 2 JWS | Legacy shared secret compatibility |
| `keyId`, `issuerId`, `privateKey` | For App Store Server API calls | Status recovery, transaction history, consumption response, admin sync |
| `offerKeyId`, `offerPrivateKey` | For promotional offers | Mounts `/onesub/apple/offer-signature`; use the separate subscription-offer key |
| `productReceiptMaxAgeHours` | No | One-time receipt maximum age; default 72 hours |
| `consumptionInfoProvider` | No | Supplies Apple's consumable refund-review response |
| `mockMode` | Development only | Bypasses Apple calls and accepts deterministic mock receipt scenarios |
| `skipJwsVerification` | Development only | Skips Apple JWS verification; never enable in production |

`mockMode` is rejected when `NODE_ENV=production`. `skipJwsVerification` is still a dangerous
degraded mode and must be excluded from production configuration.

## Google Options

| Option | Required | Purpose |
|---|---|---|
| `packageName` | Yes when Google is enabled | Play application ID and multi-app identity |
| `serviceAccountKey` | For Play API validation/actions | JSON string containing the service-account key |
| `pushAudience` | Strongly recommended for RTDN | Expected OIDC `aud`, normally the public webhook URL |
| `pushServiceAccountEmail` | Strongly recommended with `pushAudience` | Restricts push tokens to the configured service account email |
| `productReceiptMaxAgeHours` | No | One-time receipt maximum age; default 72 hours |
| `onPriceChangeConfirmed` | No | Fire-and-forget host callback for confirmed subscription price changes |
| `mockMode` | Development only | Uses deterministic mock validation without Play API calls |

If `pushAudience` is omitted, the current webhook remains backward compatible but does not
authenticate the Pub/Sub bearer token. Configure both push fields in production.

## Multi-App Configuration

```ts
app.use(createOneSubMiddleware({
  database: { url: databaseUrl },
  apps: [
    {
      id: 'coffee',
      apple: { bundleId: 'gg.pryzm.coffee' },
      google: { packageName: 'gg.pryzm.coffee', serviceAccountKey: coffeeGoogleKey },
    },
    {
      id: 'penguinrun',
      apple: { bundleId: 'gg.pryzm.penguinrun' },
      google: { packageName: 'gg.pryzm.penguinrun', serviceAccountKey: penguinGoogleKey },
    },
  ],
  defaultAppId: 'coffee',
  store,
  purchaseStore,
}));
```

Resolution order is explicit request `appId`, Apple receipt bundle ID, then the configured default.
An `appId` may also equal a configured bundle ID or package name. Unknown explicit IDs fail closed.
Google purchase tokens do not contain a package name, so a non-default Google validation request
must send `appId`.

The Unity client sends `Application.identifier` as `appId`. The current React Native provider does
not expose an app-ID option; use the default app or a host HTTP adapter when routing a non-default
Google app.

## Middleware Infrastructure Options

| Option | Default | Production choices |
|---|---|---|
| `store` | `InMemorySubscriptionStore` | `PostgresSubscriptionStore`, `RedisSubscriptionStore`, or custom |
| `purchaseStore` | `InMemoryPurchaseStore` | `PostgresPurchaseStore`, `RedisPurchaseStore`, or custom |
| `cache` | Process-local in-memory cache | `RedisCacheAdapter` for shared Apple JWT/Google OAuth tokens |
| `webhookEventStore` | None | `RedisWebhookEventStore` for atomic multi-node deduplication |
| `webhookQueue` | Inline/synchronous behavior | `BullMQWebhookQueue` for durable retries and dead letters |

`CacheWebhookEventStore` works with any cache but uses a non-atomic get/set sequence. Prefer
`RedisWebhookEventStore` for concurrent production delivery because it uses Redis `SET NX`.

## Entitlements and Refunds

```ts
entitlements: {
  premium: { productIds: ['pro_monthly', 'pro_yearly', 'lifetime_pass'] },
  adFree: { productIds: ['remove_ads'] },
},
refundPolicy: 'immediate', // or 'until_expiry'
```

An entitlement is active when any mapped product is backed by an active/grace-period subscription
that has not expired, or by a non-consumable purchase. Consumables do not grant ongoing entitlement.
`until_expiry` applies only to subscription refunds; one-time purchase refunds revoke immediately.

## React Native SDK Configuration

```tsx
<OneSubProvider
  config={{
    serverUrl: 'https://api.example.com',
    productId: 'pro_monthly',
    appleProductId: 'ios_pro_monthly',
    googleProductId: 'android_pro_monthly',
    debug: __DEV__,
  }}
  userId={user.id}
  accountToken={user.purchaseBindingId}
>
  <App />
</OneSubProvider>
```

| Option/prop | Required | Notes |
|---|---|---|
| `config.serverUrl` | Yes | Base URL before `/onesub/*`; trailing slash is normalized |
| `config.productId` | Yes | Default subscription product ID |
| `config.appleProductId` | No | Overrides the default product on iOS |
| `config.googleProductId` | No | Overrides the default product on Android |
| `config.consumableProductIds` | Yes, if you sell consumables | Every consumable product ID. Orphan replays (app died between payment and validation) have no in-flight call to read the type from; without this list they resolve to `non_consumable`, which records the wrong type on the server and acknowledges instead of consuming — on Android that blocks repurchase permanently. An explicit `purchaseProduct(id, type)` always wins over this list. |
| `config.mockMode` | Development only | Returns synthetic SDK success without native IAP or server calls |
| `config.debug` | No | Verbose purchase-flow logs |
| `config.logger` | No | SDK `{ info, warn, error }` sink |
| `userId` | Yes | Host account identity sent to the server |
| `accountToken` | No, recommended | Must be the same stable identity as `userId`; UUID on Apple, at most 64 chars on Android |

Do not place store private keys, service-account JSON, database URLs, or `adminSecret` in the mobile
configuration.

## Environment Variables Used by Repository Entrypoints

The library accepts configuration objects; environment-variable names are conventions used by the
included CLI template, standalone server entrypoint, examples, dashboard, and E2E scripts.

| Variable | Consumer | Purpose |
|---|---|---|
| `APPLE_BUNDLE_ID`, `APPLE_SHARED_SECRET` | CLI/example/standalone server | Default Apple app |
| `APPLE_KEY_ID`, `APPLE_ISSUER_ID`, `APPLE_PRIVATE_KEY` | Example/standalone/E2E | App Store Server API credentials |
| `GOOGLE_PACKAGE_NAME`, `GOOGLE_SERVICE_ACCOUNT_KEY` | CLI/example/standalone/E2E | Default Google app and Play API credential |
| `GOOGLE_PUSH_AUDIENCE` | CLI-generated server | Pub/Sub OIDC audience |
| `DATABASE_URL` | CLI/example | PostgreSQL connection selected by host code |
| `REDIS_URL` | Example server | Redis stores, cache, idempotency, and BullMQ |
| `ADMIN_SECRET` | CLI/example | Admin and metrics authentication |
| `PORT` | CLI/example/standalone | HTTP port; default 4100 |
| `ONESUB_SERVER_URL` | Dashboard | Upstream OneSub server base URL |
| `NODE_ENV` | Server/dashboard | Production mock guard and secure dashboard cookie |

See [`TESTING.md`](TESTING.md) for E2E-only variables. Keep multiline PEM and JSON values intact
when loading them from a secret manager.
