---
"@jeonghwanko/onesub-sdk": minor
"@onesub/shared": minor
---

Add `OneSubConfig.appId` — clients of a multi-app server can now name their app.

The server already matched validate requests by `appId` (falling back to the
Apple receipt's bundleId, then the default app), but the SDK never sent one.
That made Android subscriptions unusable for any non-default app: a Google
purchase token does not name its package, so validation fell through to the
default app's credentials and was rejected. Set `appId` (the app's server-side
id, Apple bundleId, or Google packageName) and every subscription/purchase
validate call — purchase and restore paths alike — carries it. Omitted, the
wire format is unchanged.
