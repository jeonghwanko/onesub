---
"@onesub/shared": patch
"@onesub/server": patch
---

Add admin endpoint for fetching a single subscription record — backs the dashboard's subscription detail page.

**Server**

- New `GET /onesub/admin/subscriptions/:transactionId` route. Returns the matching `SubscriptionInfo`, or `404 TRANSACTION_NOT_FOUND` when the id is unknown. Gated by `X-Admin-Secret` like the rest of the admin scope.
- Reuses the existing `SubscriptionStore.getByTransactionId` — no new store API surface.

**Shared**

- New `ROUTES.ADMIN_SUBSCRIPTION_DETAIL` constant.
