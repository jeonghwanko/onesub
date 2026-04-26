---
"@onesub/shared": minor
"@onesub/server": minor
---

Add admin endpoint for filtered/paginated subscription listing — backs the dashboard's subscriptions page and ad-hoc operational scripts.

**Server**

- New `GET /onesub/admin/subscriptions` route accepting `userId`, `status`, `productId`, `platform`, `limit` (max 200), `offset`. Gated by `X-Admin-Secret`.
- `SubscriptionStore` interface gains `listFiltered(opts)`. InMemory and Postgres implementations both supported (Postgres uses `updated_at DESC` with parallel count + page query).
- Admin auth middleware now also covers the `/onesub/admin` scope (was previously only `/onesub/purchase/admin`).

**Shared**

- New `ListSubscriptionsQuery` and `ListSubscriptionsResponse` types.
- New `ROUTES.ADMIN_SUBSCRIPTIONS` constant.
