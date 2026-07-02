---
'@jeonghwanko/onesub-sdk': minor
---

Add an optional `accountToken` prop to `OneSubProvider`. When set, it is passed
to StoreKit as `appAccountToken` (iOS) and Google Play as `obfuscatedAccountId`
at purchase time, binding the purchase to a stable
account identity. Pair it with the matching `@onesub/server` account-binding
guard so a leaked receipt cannot be attributed to a different account. Omit it to
keep the previous unbound behavior. Read via an internal ref so asynchronously
resolved tokens are always current without re-creating the purchase callbacks.
