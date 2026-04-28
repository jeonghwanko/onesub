---
"@onesub/providers": minor
"@onesub/mcp-server": minor
---

feat: extract @onesub/providers + full IAP CRUD in mcp-server

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
