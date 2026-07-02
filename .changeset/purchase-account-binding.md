---
'@onesub/server': patch
---

Bind product purchase validation to the receipt's `appAccountToken`. The
`/purchase/validate` route now rejects saving or reassigning a validated
non-consumable/consumable purchase to a `userId` that does not match the
`appAccountToken` baked into the receipt at purchase time. This closes a path
where a leaked or shared (but cryptographically valid) JWS could be attributed
or reassigned to an attacker-chosen `userId`. Backward compatible: receipts made
before the client sets `appAccountToken` carry no token and keep the previous
behavior (including reinstall reassignment). Apple `AppleProductResult` now
surfaces `appAccountToken`.
