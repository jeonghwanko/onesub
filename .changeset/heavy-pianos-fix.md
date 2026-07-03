---
"@onesub/server": minor
"@onesub/shared": minor
---

Google subscription lifecycle + validation hardening (review sweep).

- **Google records are now keyed by `purchaseToken`** instead of `latestOrderId` — RTDN webhooks and `linkedPurchaseToken` chains only carry the token, so refunds/cancellations/renewals previously never found the record created by `/onesub/validate`. See `docs/MIGRATION.md` for the impact on existing rows.
- **`POST /onesub/validate` now enforces account binding**: a receipt carrying Apple `appAccountToken` / Google `obfuscatedExternalAccountId` can only be bound to a matching `userId` (409 `TRANSACTION_BELONGS_TO_OTHER_USER`), mirroring the one-time purchase guard. Apple ids compare case-insensitively (lowercase-normalized UUIDs), Google ids verbatim.
- **Webhook idempotency is failure-safe**: `WebhookEventStore` gained an optional `unmark()`, and both webhook routes un-mark the event id when processing fails after dedup-marking — a transient store outage no longer permanently drops the retried event.
- **Apple webhook enforces `bundleId`** (400 `BUNDLE_ID_MISMATCH`, mirroring the Google packageName check) and **`CONSUMPTION_REQUEST` no longer revokes**: it is a refund *review* request; only `REFUND`/`REVOKE` remove entitlement.
- **Google push auth hardened**: OIDC push tokens must carry a Google issuer (both documented forms accepted), and the new `google.pushServiceAccountEmail` config verifies the `email` claim.
- Unknown Google notification types preserve the stored status instead of resurrecting canceled/expired records — without defeating the Play re-fetch correction.
- Store fixes: Redis/in-memory userId rebinds clean up the old owner's index (one subscription can no longer stay active on two accounts); Redis `savePurchase` is claim-atomic and self-heals indexes on retry; Postgres pools survive idle-client errors; Postgres `savePurchase` uses `ON CONFLICT` instead of racing SELECT-then-INSERT.
- Admin: `POST /onesub/purchase/admin/transfer` moves only the named transaction (no longer destroys sibling consumable rows) and reports 404 when the row vanished mid-flight.
- OpenTelemetry tracing actually activates when `@opentelemetry/api` is installed (the previous loader could never resolve it).
