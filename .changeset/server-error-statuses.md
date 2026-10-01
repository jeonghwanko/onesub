---
"@onesub/server": minor
"@onesub/shared": minor
---

Answer failures with the status that says whose fault it is, and close two production gaps. See docs/MIGRATION.md (0.27.x → 0.28.0).

- `mockMode` / `skipJwsVerification` are refused at startup under `NODE_ENV=production`, on the top-level config and on every `apps[]` entry. Before, a per-app `mockMode` bypassed the guard.
- A Google Play outage (5xx, 429, timeout, refused credentials) is `503 PROVIDER_UNAVAILABLE` (new error code) instead of `422 RECEIPT_VALIDATION_FAILED`. `validateGoogleReceipt` throws `ProviderUnavailableError` in that case instead of returning `null`.
- Re-posting an Apple transaction signed before a refund no longer re-activates the canceled subscription.
- An unknown `appId` or foreign Apple `bundleId` is a 400 (`INVALID_INPUT` / `BUNDLE_ID_MISMATCH`), not a 500.
- A concurrently claimed purchase is 409, not 500. Admin reset/transfer/grant report store failures as `STORE_ERROR`.
- `/onesub/*` routes answer malformed or oversized JSON, and any error that escapes a route, with the JSON error body instead of Express's HTML page.
- Apple summary notifications no longer crash the webhook.
- `BullMQWebhookQueue` job ids no longer contain `:`, which BullMQ 5 rejected on every enqueue.
