---
'@jeonghwanko/onesub-sdk': patch
---

Stop re-rendering every `useOneSub()` consumer on every provider render.

The context value was rebuilt on each render, and the purchase/restore
callbacks depended on the whole `config` object — which is a new object every
render for the common `config={{ ... }}` inline-literal usage. Together that
handed consumers a fresh context identity on any render of the tree above the
provider.

The config is now read through a ref (the same pattern already used for
`accountToken`), so those callbacks are stable, and the context value is
memoized. No API change.

This also fixes a latent staleness bug: the mount effect re-runs only on
`serverUrl` / `userId`, so a host that changed another config field — notably
adding a `consumableProductIds` entry — kept feeding the purchase listener the
config captured at mount. Orphan-replay purchase-type resolution reads exactly
that list, so a consumable could be recorded as `non_consumable` even after the
host declared it correctly.
