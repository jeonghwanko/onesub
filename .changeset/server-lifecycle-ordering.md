---
"@onesub/server": minor
"@onesub/shared": minor
---

Make subscription state follow the newest store snapshot, hold the three stores to one contract, and validate the config at startup. See docs/MIGRATION.md (0.28.0).

- `SubscriptionInfo.stateAsOf` (new Postgres column `state_as_of`, added by `initSchema()`) records the newest snapshot applied: the Apple `signedDate` or Google `eventTimeMillis` of a notification, an Apple transaction's `signedDate`, or a live store read. Older notifications and receipts no longer roll a record back, so a late EXPIRED or ON_HOLD cannot undo a renewal or recovery.
- During an Apple billing grace period `expiresAt` is the grace period's end, so `grace_period` records grant access as Apple requires.
- `GET /onesub/status` evaluates all of a user's subscriptions, not only the most recently written one.
- `isSubscriptionEntitled()` / `ENTITLED_SUBSCRIPTION_STATUSES` in `@onesub/shared` are the single definition of "active".
- Every built-in `PurchaseStore` refuses a second non-consumable row for the same user and product with `NON_CONSUMABLE_ALREADY_OWNED` (new `purchaseConflict()` helper). The in-memory store's list ordering now matches Postgres and Redis.
- `createOneSubMiddleware` validates the config at startup: an invalid `serviceAccountKey`, an unknown `defaultAppId` and duplicate app ids are refused. `database` is optional and deprecated. `node dist/index.js` uses Postgres stores when `DATABASE_URL` is set.
- Webhook bodies that are not JSON, or whose payload field is not a string, get a 400.
- `SubscriptionStore.save()` applies the ordering rule atomically (Postgres conditional upsert, a Redis Lua script over `onesub:sub:asof:<id>`), so concurrent deliveries cannot land out of order. An Apple `/validate` receipt changes a stored subscription only when it brings a later expiry or a revocation; an outdated receipt for another user's subscription is refused with 409. `ProviderUnavailableError` is exported.
