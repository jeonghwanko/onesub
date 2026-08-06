---
'@onesub/server': patch
---

Stop rejecting a legitimate restore of an already-consumed Google consumable.

onesub consumes a consumable the moment it validates it, so every later look at a
purchase it already recorded — an in-session restore, a pending order the store
re-surfaces, a retry after a dropped response — came back with
`consumptionState: 1`. `validateGoogleProductReceipt` returned `null` for that,
which the validate route turned into `422 RECEIPT_VALIDATION_FAILED`, so the
idempotent-restore path a few lines below was unreachable for Android consumables.

Clients read a 422 as an authoritative verdict about the receipt: they stop
retrying and never confirm the order. The result was a purchase onesub had on
record being silently lost to a player who had already been charged.

The provider now reports `alreadyConsumed` instead of deciding, and the route
rejects only when the token is consumed **and** no purchase row exists — which is
the actual replay signal. Purchase state, receipt age and missing order id remain
hard failures, and non-consumables are unaffected.
