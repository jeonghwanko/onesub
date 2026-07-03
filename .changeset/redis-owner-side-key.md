---
"@onesub/server": patch
---

RedisSubscriptionStore: add an `onesub:sub:owner:<originalTransactionId>` side-key (→ userId, written in the same MULTI as the record). `save()` now reads this small key to detect userId rebinds instead of GET + JSON.parse of the full record on every save. Records written by older versions have no side-key; `save()` falls back to the full record once and backfills the side-key on the next write. No migration needed.
