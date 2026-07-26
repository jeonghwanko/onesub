---
'@onesub/server': minor
---

Mount `POST /onesub/webhook/google` only when the config serves Google Play.

The route was registered unconditionally. It is now registered only when there is a
top-level `google` block or a `google` block on an `apps[]` entry.

Unlike the Apple webhook, this route does not authenticate unconditionally — the
Pub/Sub OIDC token is verified only when an app declares a `pushAudience` — and its
`voidedPurchaseNotification` branch needs no Google credentials to run: it cancels a
subscription by `purchaseToken`, or deletes a one-time purchase row by `orderId`,
straight from the payload. An Apple-only deployment therefore exposed an
unauthenticated endpoint that could revoke entitlement, with no Google purchases for
it to be about. It now returns 404 there.

The Apple webhook stays unconditional: it verifies the `signedPayload` JWS against
the bundled Apple roots on every request regardless of config, so it is not open in
the same way. A test asserts that asymmetry rather than leaving it to be inferred.

If you serve Google Play nothing changes. If you do not, drop any monitoring that
expects a 2xx/4xx on that path — see `docs/MIGRATION.md`.

The startup warnings added in 0.21.2 now stay silent for a deployment that does not
serve Google, since there is no longer an exposed route to warn about. Mounting and
warning share one predicate so they cannot disagree.
