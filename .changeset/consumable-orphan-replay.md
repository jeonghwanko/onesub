---
"@jeonghwanko/onesub-sdk": minor
"@onesub/shared": minor
---

Add `config.consumableProductIds` so orphan replays resolve consumables correctly.

A store transaction carries no consumable flag, so the SDK learned it from the
in-flight `purchaseProduct(id, 'consumable')` call. An orphan replay — the app
died between payment and validation, and the store redelivers at next launch —
has no such call and fell back to `non_consumable`. That recorded the wrong
`type` on the server (host grants keyed on `consumable` never fired) and
acknowledged instead of consumed, permanently blocking repurchase on Android.
Both failures were silent.

Hosts that sell consumables should list their product IDs; an explicit
`purchaseProduct(id, type)` still wins over the list. Behavior is unchanged for
hosts that do not set it.
