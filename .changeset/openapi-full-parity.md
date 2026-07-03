---
"@onesub/server": patch
---

OpenAPI spec now covers the full mounted HTTP surface (docs/spec only, no runtime behavior change):

- **Added missing paths**: `POST /onesub/purchase/validate`, `GET /onesub/purchase/status`, `GET /onesub/entitlement`, the purchase admin routes (`DELETE /onesub/purchase/admin/{userId}/{productId}`, `POST /onesub/purchase/admin/transfer`, `POST /onesub/purchase/admin/grant`), `GET /onesub/admin/subscriptions/{transactionId}`, `POST /onesub/admin/sync-apple/{originalTransactionId}`, all four metrics routes (`/onesub/metrics/active`, `/started`, `/expired`, `/purchases/started`), and `POST /onesub/apple/offer-signature` — with request bodies, query/header params, and response schemas.
- **Canonical error shape**: new `ErrorResponse` component (`{ error, errorCode }`, errorCode enum generated from `ONESUB_ERROR_CODE`) referenced by every documented 4xx, including the previously undocumented 409/422 responses on the validate routes.
- **Real parity test**: `openapi.test.ts` now mounts every conditional router via `createOneSubMiddleware` (adminSecret + entitlements + both mock platforms + offer keys + DLQ queue), walks the express router stack, and asserts spec ⊇ routes and routes ⊇ spec — the "every mounted path is described" claim in openapi.ts is now mechanically enforced instead of spot-checked.
