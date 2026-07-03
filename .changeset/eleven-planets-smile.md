---
"@jeonghwanko/onesub-sdk": minor
---

React Native SDK error-contract and purchase-flow fixes.

- `validateReceipt`/`validatePurchase` return the server's structured error body (`valid:false` + `errorCode`) instead of discarding it — host code branching on `RECEIPT_VALIDATION_FAILED` / `TRANSACTION_BELONGS_TO_OTHER_USER` now actually works. Non-onesub JSON (proxy 502/429) still throws and classifies as transient `INTERNAL_ERROR`.
- User cancellation delivered via `purchaseErrorListener` is recognized: `purchaseProduct` returns null and `subscribe` returns quietly instead of throwing.
- Purchase-flow races: in-flight timeout timers only act on their own entry; external deletes clear the timer; suppressed (drain-window) replays can no longer evict a live entry; the drain window re-arms on `userId`/`serverUrl` changes; a provider unmount rejects parked callers with `PROVIDER_UNMOUNTED` instead of resuming them on a torn-down session.
- `restore()` no longer posts an empty receipt (structured `NO_RECEIPT_DATA` instead); Paywall CTA failures are logged instead of vanishing as unhandled rejections; fixed a conditional `useEffect` (Rules of Hooks).
- `checkEntitlement`/`checkEntitlements` and the entitlement response types are exported from the package root.
