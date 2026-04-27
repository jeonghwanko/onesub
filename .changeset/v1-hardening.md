---
"@onesub/server": minor
"@onesub/shared": patch
---

v1.0 hardening — cluster-safe runtime, webhook idempotency + queue, dual ESM/CJS build.

**@onesub/server**

- Add `RedisSubscriptionStore`, `RedisPurchaseStore`, and `RedisCacheAdapter` for multi-instance deployments. `ioredis` is an optional peer.
- Introduce `CacheAdapter` interface (in-memory default) routed through Apple JWT / Google OAuth caches. Pass `cache: new RedisCacheAdapter(redis)` in middleware config to share token mints across nodes.
- Add `WebhookEventStore` for inbound idempotency — `InMemoryWebhookEventStore` for single-instance, `CacheWebhookEventStore` over Redis for multi-instance. Apple `notificationUUID` and Google Pub/Sub `messageId` are now deduped before any state change when the store is configured.
- Add `WebhookQueue` interface — `InProcessWebhookQueue` (synchronous, default) and `BullMQWebhookQueue` for Redis-backed durable retries with a dead-letter list. `bullmq` is an optional peer.
- New admin endpoints when a queue with DLQ support is configured:
  - `GET  /onesub/admin/webhook-deadletters`
  - `POST /onesub/admin/webhook-replay/:id`
- Build now emits both ESM (`dist/index.js`) and CJS (`dist/index.cjs`) via tsup. `package.json#exports` updated. Bundle size budget enforced via size-limit (~23 KB gzipped each).
- Hand-maintained OpenAPI 3.1 document exported as `ONESUB_OPENAPI` plus an `openapiHandler()` for self-hosting `/openapi.json`.
- Optional OpenTelemetry tracing helper `withSpan` — zero overhead when `@opentelemetry/api` is not installed.
- Postgres schema gains filter-helper indexes (`status`, `platform`, `productId` × `updated_at DESC`) — backs `/onesub/admin/subscriptions` queries without full-table sorts.
- New ops doc: `docs/POSTGRES.md`.

**@onesub/shared**

- `AppleNotificationPayload` now exposes the optional top-level `notificationUUID` field that Apple stamps on every notification — used by the new webhook idempotency store.
