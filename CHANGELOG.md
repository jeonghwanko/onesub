# Changelog

## v0.3.0 / sdk@0.2.0 — 2026-04-08

### @onesub/server@0.3.0

**Provider-level product validators:**
- `validateAppleConsumableReceipt(jws, config, expectedProductId?)` — validates Apple JWS for `Consumable` and `NonConsumable` types
  - Uses `transactionId` (not `originalTransactionId`) as dedup key — prevents replay across re-purchases
  - Rejects `Auto-Renewable Subscription` and `Non-Renewing Subscription` types
  - Enforces 72-hour receipt age limit
  - Blocks revoked/refunded transactions
- `validateGoogleProductReceipt(token, productId, config, type?)` — validates via `purchases.products` API (not `purchases.subscriptions`)
  - `consumptionState === 1` blocks consumable replay (already-consumed token)
  - Non-consumables allow `consumptionState === 1` (normal after acknowledgement)
  - Enforces 72-hour receipt age limit
  - Uses `orderId` as `transactionId` (per-purchase unique, unlike `purchaseToken`)
- 24 new provider unit tests (69 total)

### @onesub/sdk@0.2.0

**`purchaseProduct()` — one-time product purchase:**
- New `purchaseProduct(productId, type)` method on `useOneSub()` context
  - `type: 'consumable' | 'non_consumable'`
  - Returns `PurchaseInfo` on success, `null` on user cancel, throws on validation failure
  - `finishTransaction` always called in `finally` (Android 3-day auto-refund prevention)
  - `isBusyRef` lock prevents concurrent calls
- New `validatePurchase()` client function in `api.ts`
- New exports: `PurchaseType`, `PurchaseInfo`, `ValidatePurchaseRequest`, `ValidatePurchaseResponse`, `PurchaseStatusResponse`
- Fixed `restore()`: `singlePurchase` declared before `try` block, `finishTransaction` in `finally`
- Added `endConnection()` in `useEffect` cleanup

---

## v0.2.0 — 2026-04-07

### @onesub/shared + @onesub/server

**Consumable + Non-consumable IAP support:**
- New types: `PurchaseType`, `PurchaseInfo`, `ValidatePurchaseRequest`, `ValidatePurchaseResponse`
- New routes: `POST /onesub/purchase/validate`, `GET /onesub/purchase/status`
- New stores: `InMemoryPurchaseStore`, `PostgresPurchaseStore`
- Non-consumable duplicate prevention: PostgreSQL partial unique index on `(user_id, product_id)` for `non_consumable` rows
- Transaction ID idempotency: replay returns existing record
- `subscription` type rejected at purchase endpoint to prevent split state
- 6 new tests (45 total)

onesub now covers the complete react-native-iap server side: subscriptions, consumables, and non-consumables.

---

## v0.3.0 — 2026-04-07

### @onesub/mcp-server

**New MCP tools (7 total):**
- `onesub_create_product` — Create subscriptions on App Store Connect + Google Play via API
- `onesub_list_products` — List registered products from both stores
- `onesub_view_subscribers` — Query subscription status from onesub server

**Product creation upgrades:**
- Auto bundle ID → App ID resolution (no manual lookup needed)
- Auto price point search with pagination
- Auto price setting + Korean localization for KRW products
- `APPLE_KRW_COMMON_PRICES` — 34 fixed Apple KRW price tiers embedded
- Actionable error messages: DUPLICATE shows existing products, AUTH shows fix guide

### @onesub/server

**Security hardening:**
- Apple JWS signature verification via JWKS (`jose.jwtVerify`)
- Google webhook JWT authentication (`pushAudience` config)
- Google OAuth token caching with thundering-herd protection
- zod input validation on `/onesub/validate`
- Request body size limit (50KB)
- Removed unsafe pre-decoded Apple webhook path

**SSOT cleanup:**
- All status string literals replaced with `SUBSCRIPTION_STATUS` constants
- Removed duplicate `AppleConfig` / `GoogleConfig` interfaces

**New:**
- `PostgresSubscriptionStore` — production-ready persistent storage
- Direct provider exports (`validateAppleReceipt`, `validateGoogleReceipt`)

## v0.1.0 — 2026-04-07

Initial release.

- `@onesub/server` — Express middleware for Apple StoreKit 2 + Google Play Billing receipt validation
- `@onesub/sdk` — React Native SDK with `useOneSub()` hook and `<Paywall />` component
- `@onesub/mcp-server` — 4 MCP tools for AI-assisted subscription setup
- `@onesub/shared` — Shared TypeScript types and constants
