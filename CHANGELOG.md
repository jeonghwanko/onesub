# Changelog

## server@0.6.2 / sdk@0.4.1 / shared@0.3.1 — 2026-04-20

**`action` field on `POST /onesub/purchase/validate`:**
- `ValidatePurchaseResponse.action?: 'new' | 'restored'` (present on `valid: true`)
  - `'new'` — freshly inserted (first time this `transactionId` was seen)
  - `'restored'` — `transactionId` already existed (idempotent replay or reassigned from a prior owner)
- SDK: `purchaseProduct()` / `restoreProduct()` return `(PurchaseInfo & { action? }) | null` — apps can branch UX on "구매 완료" vs "복원 완료".
- Fixes ordering bug where the idempotency short-circuit ran before the reassign path, causing `0.6.1`'s auto-reassign to never fire on reinstalled devices.

## server@0.6.1 — 2026-04-20

**Non-Consumable JWS auto-reassignment:**
- Device reinstall (new deviceId, same Apple ID, same receipt) no longer trips `TRANSACTION_BELONGS_TO_OTHER_USER` for non-consumables — the validate route auto-reassigns ownership via `PurchaseStore.reassignPurchase(transactionId, newUserId)`.
- Safe because `0.6.0` already verifies the JWS chain up to Apple's root CA — a valid JWS proves the caller owns the original Apple account.
- Consumables still return `409` (receipt reuse has no legitimate semantics there).
- New `PurchaseStore.reassignPurchase()` method (InMemory + Postgres).

## server@0.6.0 — 2026-04-20 — BREAKING

**Apple Root CA G3 chain verification:**
- Previously only the leaf cert in the JWS `x5c` header was used to verify the signature — a self-signed cert could mint a passing JWS.
- Now the full `x5c` chain is verified: each cert signed by the next, all within their validity window, and the final cert issued by a bundled Apple root CA.
- `packages/server/src/providers/apple-root-ca.ts` embeds Apple Root CA G3 PEM (valid until 2039-04-30). Add G4 there when Apple publishes it.
- Implemented with `node:crypto.X509Certificate` — zero new dependencies.
- **Breaking** for anyone who was relying on non-Apple-issued test JWS.

## server@0.5.0 — 2026-04-20 — BREAKING

**Transaction ownership enforcement (security):**
- Old `savePurchase` used `ON CONFLICT (transaction_id) DO NOTHING`, so the same Apple/Google `transactionId` submitted under a different `userId` silently no-op'd while the server still responded `valid: true` — letting an attacker reuse one receipt across many accounts.
- New behavior: same `transactionId` + different `userId` → throws `TRANSACTION_BELONGS_TO_OTHER_USER`. Same user → idempotent no-op.
- `POST /onesub/purchase/validate` maps this to `HTTP 409`.
- New admin endpoint `POST /onesub/purchase/admin/transfer` for legitimate device/account migrations.
- Applied to both `InMemoryPurchaseStore` and `PostgresPurchaseStore`.

## server@0.4.0 / sdk@0.4.0 / shared@0.3.0 — 2026-04-20

**Admin routes (server, `config.adminSecret` required):**
- Mounted only when `config.adminSecret` is set; all requests must send matching `X-Admin-Secret` header (else `401`).
- `DELETE /onesub/purchase/admin/:userId/:productId` — wipe a non-consumable record so the user can re-test the purchase flow.
- `POST /onesub/purchase/admin/grant` — manually insert a purchase record, bypassing store verification.
- New `PurchaseStore.deletePurchases(userId, productId)` method.

**SDK mock mode (`config.mockMode: true`):**
- `subscribe()` / `restore()` / `purchaseProduct()` / `restoreProduct()` return synthetic success without touching `react-native-iap` or the onesub server.
- Intended for Expo Go / simulator UI-flow testing. Logs a one-shot warning; never enable in production.

## server@0.3.4 — 2026-04-15

**StoreKit 2 JWS signature verification:**
- Verifies the JWS signature using the public key from the `x5c` leaf certificate (was previously decoded-only in some paths).

## server@0.3.3 — 2026-04-10

**`ONESUB_ALLOW_SANDBOX` env flag:**
- Set `ONESUB_ALLOW_SANDBOX=true` on a production `NODE_ENV` server to also accept TestFlight sandbox receipts — useful for running QA on the same server before App Store release.

## sdk@0.3.0 – 0.3.4 — 2026-04-09 – 2026-04-14

- `0.3.0` — react-native-iap **v15** compatibility.
- `0.3.1` — v15 event-based purchase pattern (`requestPurchase` no longer returns the purchase; subscribe via `purchaseUpdatedListener`).
- `0.3.2` / `0.3.3` — `restoreProduct(productId, type)`: restore a one-time non-consumable from the store's purchase history (returns `null` if the store has no record).

## server@0.3.1 — 2026-04-08

### @onesub/server@0.3.1

**Google consumable auto-refund prevention:**
- Added `consumeGoogleProductReceipt(purchaseToken, productId, config)` — explicitly consumes a Google Play purchase via `purchases.products/{productId}/tokens/{token}:consume`
- Must be called after entitlement is granted; Google auto-refunds unconsumed purchases after 3 days
- `POST /onesub/purchase/validate` now calls this automatically for Google consumables (fire-and-forget, after DB save succeeds)
- Shared token cache (`getCachedAccessToken`) reused — no extra OAuth round-trip
- Failures are logged with auto-refund risk warning but do not affect the response

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
