---
"@onesub/server": patch
"@jeonghwanko/onesub-sdk": patch
---

Fix: already-owned non-consumable now returns the recorded transactionId

Re-purchasing (or replaying the store event for) a non-consumable the user
already owns previously dropped the transaction id. The server returned
`409 NON_CONSUMABLE_ALREADY_OWNED` with `purchase: null`, and the SDK
synthesized a `restored` result with no `transactionId` — violating the
`PurchaseInfo` contract. Hosts that re-entitle off `result.transactionId`
(e.g. registering their own pass against the receipt) received `undefined`,
so a charged user could be left without their entitlement.

- **server**: `POST /onesub/purchase/validate` now treats an already-owned
  non-consumable as an idempotent restore — it returns `200 { valid: true,
  action: 'restored', purchase }` with the recorded purchase (and its real
  `transactionId`) instead of a 409 error. Ownership was already proven by the
  prior validated purchase, matching the existing transactionId-match restore
  semantics.
- **sdk**: both already-owned synthesis paths (`handlePurchaseEvent` and
  `restoreProduct`) now carry the store `transactionId` through, as a defensive
  fallback for servers still returning the legacy 409.
