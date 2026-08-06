---
'@onesub/server': patch
---

Name the product and app when a subscription is sent to the product endpoint.

`validateAppleConsumableReceipt` rejects a receipt whose type is not
`Consumable`/`Non-Consumable`, but logged only the type. On a host serving several
apps that says a subscription went to the wrong endpoint and nothing else — not
which app, not which product, not whose purchase just failed with a 422.

Eleven of these landed over four days in 2026-07 and none could be attributed from
the logs; identifying the source took correlating warning timestamps against
successful-purchase rows in the database. The line now carries `productId` (from the
receipt, falling back to the requested id) and `bundleId`.
