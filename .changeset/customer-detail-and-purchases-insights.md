---
"@onesub/shared": patch
"@onesub/server": patch
---

Two related additions backing the dashboard's customer detail page and lifetime-product host insights.

**Server**

- New `GET /onesub/admin/customers/:userId` route — returns subscriptions + purchases + entitlements (when configured) for one user in a single round-trip. Always 200 (unknown userId yields empty arrays + omitted entitlements). Gated by `X-Admin-Secret`.
- New `GET /onesub/metrics/purchases/started?from=&to=&groupBy=day` route — counts non-consumable purchases by `purchasedAt`, mirroring `/metrics/started`'s shape. Consumables are excluded (entitlement-irrelevant). Supports the same `groupBy=day` zero-filled bucketing.
- `MetricsActiveResponse.byProductPurchases` field — non-consumable product distribution, separate from the existing `byProduct` (which stays subs-only).

**Shared**

- New `CustomerProfileResponse` type.
- New `ROUTES.ADMIN_CUSTOMER_DETAIL` and `ROUTES.METRICS_PURCHASES_STARTED` constants.
- `MetricsActiveResponse.byProductPurchases` (additive — present in every response, defaults to `{}`).
