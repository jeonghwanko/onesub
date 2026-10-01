---
"@onesub/server": minor
"@onesub/shared": minor
---

Answer failures with the status that says whose fault it is, and close two production gaps. See docs/MIGRATION.md (0.27.x → 0.28.0).
- `mockMode` / `skipJwsVerification` are refused at startup under `NODE_ENV=production`, on the top-level config and on every `apps[]` entry. Before, a per-app `mockMode` bypassed the guard.
- A Google Play outage (5xx, 429, timeout, refused credentials) is `503 PROVIDER_UNAVAILABLE` (new error code) instead of `422 RECEIPT_VALIDATION_FAILED`. The exported `validateGoogleReceipt` still returns `null` in that case (unchanged contract); `ProviderUnavailableError` is exported for hosts that want the distinction.
- Re-posting an Apple transaction signed before a refund no longer re-activates the canceled subscription.
- A concurrently claimed purchase is 409, not 500. Admin reset/transfer/grant report store failures as `STORE_ERROR`.
- `/onesub/*` routes answer malformed or oversized JSON with the JSON error body instead of Express's HTML page; other errors still reach the host's error handler. `createOneSubServer` answers them with a JSON 500.
- Apple summary notifications no longer crash the webhook.
- `BullMQWebhookQueue` job ids no longer contain `:`, which BullMQ 5 rejected on every enqueue.
- Concurrent duplicate `/onesub/purchase/validate` requests for one transaction no longer both answer `action: "new"` (a consumable granted twice); within a process the second answers `restored`.
- A rejected Google service-account key (OAuth `400 invalid_grant`) answers 503 `PROVIDER_UNAVAILABLE` instead of a final 422. A failed store lookup in `/validate` no longer drops the save. A request waiting behind a hung purchase claim proceeds after 30 s.
