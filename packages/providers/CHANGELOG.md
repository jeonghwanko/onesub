# @onesub/providers

## 0.4.0

### Minor Changes

- 8c6a26b: Fix one-time IAP product creation against the current store APIs.

  - **Apple**: create / update / delete / pricePoints now target the standalone
    `/v2/inAppPurchases` resource. The previous `POST /v1/inAppPurchasesV2` path is
    rejected by App Store Connect with "The path provided does not match a defined
    resource type". The app→IAP relationship list (`/v1/apps/{id}/inAppPurchasesV2`)
    and price schedules (`/v1/inAppPurchasePriceSchedules`) remain on v1.
  - **Google Play**: migrate one-time product create / update / delete / list from
    the deprecated `inappproducts` API (writes now fail with "Please migrate to the
    new publishing API") to `monetization.onetimeproducts` (purchaseOptions +
    regional pricing/availability, `{units, nanos}` money). New products are created
    with a DRAFT purchase option — activate in Play Console after creation.

## 0.3.1

### Patch Changes

- 75a2396: Retry HTTP 429/503 in the Apple and Google request helpers (`appleRequest`, `playRequest`, and the Google OAuth token fetch): up to 2 retries, honoring a numeric `Retry-After` header (capped at 30s) with 1s/4s exponential backoff otherwise. App Store Connect hourly rate limits tripped by bulk operations (multi-region price setting paginates the full price-point list per region) previously surfaced as generic errors or a silent `priceSet: false`; exhausted retries still throw the exact same error shapes, so downstream `translateAppleError` / UNKNOWN handling is unchanged. Apple regenerates the ES256 JWT (and Google re-signs the OAuth assertion) on every retry attempt.

## 0.3.0

### Minor Changes

- 141150a: App Store Connect / Google Play wrapper correctness sweep.

  - **Apple price points now match**: `customerPrice` (major units) is normalized against the smallest-unit target, so USD/EUR/GBP prices actually set (`499` now matches `$4.99`); zero-decimal currencies unchanged. `findApplePricePoint` accepts an optional `currency` arg; unmapped territories without it fall back to major-unit comparison.
  - Empty-body 2xx responses (204 DELETE) are treated as success on both platforms instead of throwing on `JSON.parse('')`.
  - Google OAuth token cache is keyed by a SHA-256 of the full service-account key — the previous 40-char prefix collided across accounts and could reuse another account's token.
  - Google `subscriptions.create`/`patch` send the required `productId` and `regionsVersion.version` query params; renames merge listings so non-English locales survive.
  - Apple `inAppPurchasePriceSchedules` includes the required `baseTerritory`; EUR maps to a real territory (DEU); subscription creation reuses an existing group with the same reference name and rolls back a freshly created group on failure.
  - Full pagination on all list/lookup paths (Apple `links.next`, Google `nextPageToken`/`tokenPagination`) — products beyond the first page are no longer invisible.
  - Error reporting: lookup helpers no longer swallow auth failures as NOT_FOUND; `listProducts` throws when both halves fail instead of returning an empty catalog; `setPrice` failures surface as `priceError`; unsupported/duplicate extra-region currencies are skipped and reported via `skippedRegions` instead of corrupting the request.
  - Zero-decimal subscription prices list correctly (KRW no longer reported ×100); all requests carry a 30s timeout; ASC JWTs leave clock-skew headroom.

## 0.2.0

### Minor Changes

- d0e381b: feat: extract @onesub/providers + full IAP CRUD in mcp-server

  **New package — `@onesub/providers`**

  Standalone App Store Connect + Google Play API wrappers with zero external runtime dependencies (pure Node.js crypto + fetch).

  Full IAP CRUD for both platforms:

  - `createAppleSubscription` / `createGoogleSubscription`
  - `createAppleOneTimePurchase` / `createGoogleOneTimePurchase` — consumable & non-consumable
  - `updateAppleProduct` / `updateGoogleProduct` — rename via PATCH
  - `deleteAppleProduct` / `deleteGoogleProduct` — with `CANNOT_DELETE` guidance for approved Apple products
  - `listAppleProducts` / `listGoogleProducts`
  - `resolveAppleAppId` — bundle ID → numeric App Store Connect ID
  - `findApplePricePoint` — exact + nearest tier lookup

  All create functions accept `extraRegions?: RegionPrice[]` for multi-region pricing.

  **`@onesub/mcp-server` — breaking away from internal providers**

  - `onesub_create_product` now supports `productType: 'subscription' | 'consumable' | 'non_consumable'` and `extraRegions`; routes to the correct API endpoint per type
  - `onesub_list_products` now returns all IAP types (subscriptions + one-time)
  - New tool `onesub_manage_product` — update name or delete a product on Apple/Google
  - New tool `onesub_simulate_webhook` — send fake Apple/Google webhook to test lifecycle transitions without real store credentials
  - Removed internal `providers/apple-connect.ts` and `providers/google-play.ts` — replaced by `@onesub/providers`
