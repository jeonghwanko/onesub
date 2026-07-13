---
'@onesub/shared': minor
'@onesub/server': minor
---

Validate receipts for N apps from one onesub instance.

`OneSubServerConfig.apps[]` lets a single deployment serve several bundles, each with its own Apple bundleId and Google packageName + service account. Previously one instance validated exactly one app, so a second app's receipts were rejected as a bundle/package mismatch.

An incoming request is matched to an app by, in order: the request's `appId`; the bundleId baked into an Apple receipt (Apple clients therefore need no `appId`); then `defaultAppId`. Google purchase tokens do not name their package, so a Google request for a non-default app must send `appId`.

Webhooks route the same way — Apple notifications carry their bundleId, Google RTDNs their packageName — so each app's renewals, cancellations and refunds land on that app's credentials. Google push auth accepts any configured app's push service account, since each app pushes from its own GCP project.

Existing single-app deployments are unaffected: the top-level `apple`/`google` config stays the default app, a client that sends no `appId` still resolves to it, and "open mode" (Google configured with no `packageName`) keeps accepting any package. An `appId` or bundleId that no configured app serves resolves to no provider rather than falling back to the default, so one app's receipt is never validated against another's credentials.
