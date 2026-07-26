---
'@onesub/server': minor
'@onesub/shared': minor
---

Add sandbox-only entitlement overrides for manual testing.

Apple provides no way to cancel a sandbox subscription bought with a real Apple
Account through TestFlight — "Clear Purchase History" in App Store Connect only
covers sandbox *tester* accounts. A developer who subscribes once to check the
paywall stays entitled indefinitely and cannot re-run the purchase flow.

Deleting server records does not help: `/onesub/validate` re-derives entitlement
from Apple on every call, so any local edit is overwritten on the next launch.
The override therefore sits in front of that verdict:

- `GET /onesub/admin/test-overrides`
- `PUT /onesub/admin/test-overrides/:userId` — body `{ "entitled": false }`
- `DELETE /onesub/admin/test-overrides/:userId`

An override is keyed by `userId` and is honoured **only when the receipt just
validated came from Sandbox**, so a production customer is unaffected even if an
override exists for their id. To make that check possible, the Apple validator
now reports the receipt environment as a transient `SubscriptionInfo.sandbox`
flag, stripped by the validate route before the record reaches a store — the
same lifecycle as the existing `boundAccountId`.

Overrides are process-local and non-persistent by design: they do not survive a
restart, and in a multi-instance deployment they apply to the instance that
received the request. This keeps them a debugging aid rather than a product
feature.

This is not hypothetical. It hid a paywall entry point from App Review
(Guideline 2.1(b) "we cannot locate the In-App Purchases") because the reviewer
had subscribed in an earlier submission and the app hides that entry point for
subscribers.
