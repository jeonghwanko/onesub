# @onesub/providers

Dependency-free Node.js wrappers for managing in-app products through App Store Connect and Google
Play Developer APIs. The package creates, updates, deletes, and lists subscriptions, consumables,
and non-consumables.

This package manages store catalog metadata. It does not validate customer receipts or process
webhooks; use [`@onesub/server`](../server/README.md) for runtime purchase validation.

## Install

```bash
npm install @onesub/providers
```

Requirements:

- Node.js 20 or newer.
- App Store Connect API credentials for Apple operations.
- A Google service account with Android Publisher access for Google operations.

The package is ESM and uses built-in `crypto` and `fetch`; it has no runtime npm dependencies.

## Exports

| Apple | Google | Purpose |
|---|---|---|
| `createAppleSubscription` | `createGoogleSubscription` | Create a monthly/yearly auto-renewable subscription |
| `createAppleOneTimePurchase` | `createGoogleOneTimePurchase` | Create a consumable or non-consumable product |
| `updateAppleProduct` | `updateGoogleProduct` | Update a product display/reference name |
| `deleteAppleProduct` | `deleteGoogleProduct` | Delete a product when the store permits it |
| `listAppleProducts` | `listGoogleProducts` | List subscriptions and one-time products |
| `resolveAppleAppId` | — | Resolve numeric App Store Connect app ID from bundle ID |
| `findApplePricePoint` | — | Match a price to an Apple price-point resource |

`RegionPrice`, platform credential/product/result types, `APPLE_KRW_COMMON_PRICES`, and Apple
price-point result types are also exported.

## Price Units and Currencies

All input/output prices use the currency's smallest unit:

```ts
499  // USD 4.99
9900 // KRW 9,900
500  // JPY 500
```

Supported currency-to-store mappings are:

```text
USD, KRW, EUR, JPY, GBP, AUD, CAD, CNY, SGD
```

KRW, JPY, and other zero-decimal currencies are not divided by 100. `extraRegions` uses the same
unit rule. Unknown currencies return a structured create error rather than silently selecting a
territory.

## Apple Credentials

```ts
interface AppleCredentials {
  keyId: string;
  issuerId: string;
  privateKey: string; // contents of the App Store Connect .p8 file
}
```

Creation/update/delete accepts either the numeric `appId` or a `bundleId` that can be resolved
through App Store Connect. Listing requires the numeric `appId`.

Keep these server-side. They are App Store Connect catalog-management credentials, not the separate
subscription-offer signing key used by `@onesub/server`.

## Google Credentials

```ts
interface GoogleCredentials {
  packageName: string;
  serviceAccountKey: string; // complete service-account JSON string
}
```

The service account must be linked to the Play Console application and authorized for the catalog
operations being requested. Keep the JSON server-side and load it from a secret manager.

## Create a Subscription

### Apple

```ts
import { createAppleSubscription } from '@onesub/providers';

const result = await createAppleSubscription({
  keyId: process.env.APPLE_KEY_ID!,
  issuerId: process.env.APPLE_ISSUER_ID!,
  privateKey: process.env.APPLE_PRIVATE_KEY!,
  bundleId: 'com.example.app',
  productId: 'pro_monthly',
  name: 'Pro Monthly',
  period: 'monthly',
  currency: 'USD',
  price: 499,
  extraRegions: [
    { currency: 'KRW', price: 6600 },
    { currency: 'JPY', price: 700 },
  ],
});

if (!result.success) {
  throw new Error(`${result.errorType ?? 'UNKNOWN'}: ${result.error}`);
}
```

Apple creation creates or reuses a subscription group named from the display name, creates the
subscription, selects the nearest exact store price point, applies extra regions, and adds Korean
localization for a KRW primary price. Inspect `priceSet`, `priceError`, `priceNearest`, and
`extraRegionsSet`; `success: true` does not imply every optional regional price was applied.

### Google

```ts
import { createGoogleSubscription } from '@onesub/providers';

const result = await createGoogleSubscription({
  packageName: 'com.example.app',
  serviceAccountKey: process.env.GOOGLE_SERVICE_ACCOUNT_KEY!,
  productId: 'pro_monthly',
  name: 'Pro Monthly',
  period: 'monthly',
  currency: 'USD',
  price: 499,
  extraRegions: [{ currency: 'KRW', price: 6600 }],
});
```

Google creates an active base plan with ID `monthly` or `yearly` and an `en-US` listing. Check
`skippedRegions` for unsupported or duplicate region mappings.

## Create a One-Time Product

```ts
import {
  createAppleOneTimePurchase,
  createGoogleOneTimePurchase,
} from '@onesub/providers';

const common = {
  productId: 'lifetime_unlock',
  name: 'Lifetime Unlock',
  type: 'non_consumable' as const,
  currency: 'USD',
  price: 1999,
};

const apple = await createAppleOneTimePurchase({
  ...common,
  keyId: process.env.APPLE_KEY_ID!,
  issuerId: process.env.APPLE_ISSUER_ID!,
  privateKey: process.env.APPLE_PRIVATE_KEY!,
  bundleId: 'com.example.app',
});

const google = await createGoogleOneTimePurchase({
  ...common,
  packageName: 'com.example.app',
  serviceAccountKey: process.env.GOOGLE_SERVICE_ACCOUNT_KEY!,
});
```

Google Play represents both consumable and non-consumable products as managed one-time products;
the runtime application/server decides whether to consume or acknowledge the purchase. Consequently,
Google list results cannot reliably recover that distinction and report one-time products with a
generic consumable type.

## List, Update, and Delete

```ts
import {
  listAppleProducts,
  updateAppleProduct,
  deleteGoogleProduct,
} from '@onesub/providers';

const appleProducts = await listAppleProducts({
  keyId,
  issuerId,
  privateKey,
  appId: '1234567890',
});

await updateAppleProduct({
  keyId,
  issuerId,
  privateKey,
  appId: '1234567890',
  productId: 'pro_monthly',
  productType: 'subscription',
  name: 'Pro Monthly Plan',
});

await deleteGoogleProduct({
  packageName,
  serviceAccountKey,
  productId: 'unused_product',
  productType: 'non_consumable',
});
```

Store restrictions still apply:

- Apple product IDs and product types cannot be changed after creation.
- Apple may reject deletion of approved/published products with `CANNOT_DELETE`.
- Google subscriptions with active base plans/subscribers may not be deletable.
- Update currently changes the name/listing, not the product ID, type, period, or price.
- List operations tolerate one catalog half failing, but throw when both subscription and one-time
  catalog requests fail so an auth/network error is not mistaken for an empty store.

## Errors and Retries

Create/update/delete functions return result objects with `success` and `error`; Apple results also
provide categorized `errorType` values where available. Resolve/list helpers can throw when the
request itself cannot produce a meaningful result.

HTTP 429 and 503 responses are retried at most twice after the initial request. Numeric
`Retry-After` is honored up to 30 seconds; otherwise bounded backoff is used. Do not wrap these calls
in unbounded application retries.

Before any destructive operation, list the current products, verify application identity and
product type, and require operator approval. Product deletion is not a substitute for deactivating
a published offer through the store console.

## Development

From the monorepo root:

```bash
npm run build -w @onesub/providers
npm run type-check -w @onesub/providers
npm test -- packages/providers/src/__tests__/apple.test.ts \
  packages/providers/src/__tests__/google.test.ts
```

The tests use mocked `fetch`; normal repository tests do not mutate App Store Connect or Google Play.
