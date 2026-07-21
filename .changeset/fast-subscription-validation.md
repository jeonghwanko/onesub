---
"@jeonghwanko/onesub-sdk": patch
---

Add a transaction-correlated `subscribeWithResult()` API and public `isBusy`
state so apps can show subscription success immediately after server validation
while keeping other store mutations locked until native transaction cleanup
finishes. Add debug phase timings for drain, product fetch, store request,
validation, and transaction cleanup.
