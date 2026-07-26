---
'@jeonghwanko/onesub-sdk': patch
---

Normalize react-native-iap v15 purchase errors, preserve server validation error codes on restore failures,
pre-register StoreKit listeners before connection initialization, and report concurrent one-time purchase/restore
operations as `CONCURRENT_PURCHASE` instead of an ambiguous null result.
