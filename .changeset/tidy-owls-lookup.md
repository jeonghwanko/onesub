---
'@onesub/server': minor
---

Look up purchases by product instead of reading a user's whole history.

Non-consumable validation asked "does this user own this product?" by fetching
every purchase row the user had and filtering in process. An account with a long
consumable history — coins, lives, refills — paid to transfer all of those rows on
every single lifetime-product purchase, on a hot path.

`PurchaseStore` gains an optional `getPurchasesForProduct(userId, productId)`, and
both call sites use it when the store provides one: the non-consumable ownership
check, and `GET /onesub/purchase/status?productId=`. All three built-in stores
implement it from an index — `WHERE user_id = $1 AND product_id = $2` in Postgres,
the `user_product` set that already backed `hasPurchased` in Redis.

The method is optional, so a custom `PurchaseStore` written before it existed keeps
compiling and keeps working: those call sites fall back to the previous
full-history read and in-process filter. Responses are identical on both paths.

`GET /onesub/purchase/status` without a `productId` still returns the user's full
history and still has no pagination — bounding it means either a default limit,
which would silently truncate for hosts relying on completeness, or new query
parameters. That is a route-contract decision and is not included here.

Also fixes an ordering divergence between the stores. `InMemoryPurchaseStore`
appended new rows, so it returned purchases oldest-first while Postgres
(`ORDER BY purchased_at DESC`) and Redis returned newest-first — meaning
`/onesub/purchase/status` came back in the opposite order under `onesub dev` and in
most tests than it does in production, for the same data. All three now return
most-recent-first, and the interface states it.
