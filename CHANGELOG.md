# Changelog

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
