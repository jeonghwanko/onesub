---
'@onesub/server': minor
---

Bind product purchase validation to the account identity baked into the receipt.
The `/purchase/validate` route now rejects saving or reassigning a validated
non-consumable/consumable purchase to a `userId` that does not match the
receipt's account token — Apple `appAccountToken` (surfaced on
`AppleProductResult`) and Google `obfuscatedExternalAccountId` (surfaced on
`GoogleProductResult`). This closes a path where a leaked or shared (but
cryptographically valid) receipt could be attributed or reassigned to an
attacker-chosen `userId`. Backward compatible: receipts made before the client
sets an account token carry none and keep the previous behavior (including
reinstall reassignment).
