---
"@jeonghwanko/onesub-sdk": minor
---

Bound every server request to 60 seconds and give every thrown failure a code. A transport failure, the timeout, or a bodyless proxy 5xx/429/408 throws `OneSubError` `NETWORK_ERROR` (as `docs/RECEIPT-ERRORS.md` already documented) instead of a plain `Error`. The legacy already-owned fallback matches `errorCode` rather than the message. A failed one-time `finishTransaction` is logged instead of silently ignored. A restore or entitlement refresh that resolves after `userId` changes no longer writes the previous user's state.

A GET helper that fails keeps the server's own `errorCode` (`ENTITLEMENT_NOT_FOUND`, `STORE_ERROR`, …). The request timeout is 60 s, above the server's worst case for a Google validation plus a host pre-check.
