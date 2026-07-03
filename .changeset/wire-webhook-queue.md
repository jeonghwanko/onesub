---
"@onesub/server": minor
---

Wire `config.webhookQueue` into webhook processing. Previously the option was advertised (BullMQ retries + dead-letter queue) but never used: routes always processed inline, `setHandler()`/`enqueue()` were never called, and the admin dead-letter endpoints always showed an empty list.

- **Queue mode**: when `webhookQueue` is set, the Apple/Google webhook routes keep the cheap gating inline (body validation, JWS decode + verification / Pub/Sub push-token auth, bundleId/packageName checks, idempotency dedup) and enqueue the decoded, JSON-serializable work with a stable `provider:eventId` job id, acking 200 as soon as the job is accepted. The state-mutating processing runs in the queue handler, registered once at middleware creation. Failed jobs land in the dead-letter list for admin replay (`GET /onesub/admin/webhook-deadletters`, `POST /onesub/admin/webhook-replay/:id`).
- **No queue configured**: behavior is unchanged — inline processing with unmark-on-5xx so source retries are re-processed.
- **New exports**: `processAppleNotification` / `processGoogleNotification` (+ `AppleWebhookWork` / `GoogleWebhookWork` types) so hosts running a dedicated worker process can register the same handler themselves, and `unmarkWebhookEvent` (the unified best-effort idempotency-release helper the routes now share).
- **BullMQWebhookQueue hardening**: `setHandler()` no longer leaves a floating worker-startup promise (an unhandled rejection crashed the process when `bullmq` wasn't installed) — startup failures are captured and surfaced on the next `enqueue()`; Queue and Worker now get `'error'` listeners; `close()` tolerates a failed startup.
