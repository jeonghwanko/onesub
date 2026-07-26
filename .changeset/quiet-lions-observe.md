---
'@onesub/server': patch
---

Remove the per-entitlement store re-reads from batch entitlement evaluation.

`evaluateEntitlement` reads a user's subscriptions and purchases itself, so
callers evaluating several entitlements for one user paid two store round-trips
per entitlement. `GET /onesub/entitlements` did that for every configured
entitlement, and `GET /onesub/admin/customers/:userId` did it *serially* on top
of records it had already fetched — so a host with N entitlements issued 2N
redundant queries per request on both paths.

Both now read the user's records once and evaluate every entitlement against
them. New export `evaluateEntitlementFrom(subs, purchases, entitlement, now?)`
is the store-free evaluator for hosts that want the same batching in their own
code. `evaluateEntitlement` keeps its signature and its behavior, including
skipping the purchase read when a subscription already grants the entitlement.

Also fixes a listener leak in the shared outbound `fetch` helper: the
caller-signal `abort` listener used `{ once: true }`, which only self-removes
when the event fires, so a caller reusing one long-lived `AbortSignal` across
requests accumulated a listener per call. It is now removed on every path.
