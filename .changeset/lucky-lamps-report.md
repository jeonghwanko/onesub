---
'@onesub/server': minor
---

Finish the structured-logging migration: routes, the app registry, webhook
handlers, the BullMQ queue and the Postgres pool now log `key=value` fields.

**`userId` becomes filterable for the first time.** It arrives in a request body, so
it exists only in the route layer — the provider migration in 0.25.0 could not
deliver it. Error paths now carry the request they were serving (`userId`,
`productId`, `platform`, `notificationUUID`, `messageId`) instead of a bare stack,
and every `catch` passes the `Error` itself so the stack survives as continuation
lines.

Three prefixes changed because the value in them became a field:
`[onesub/metrics/<name>]` → `[onesub/metrics] route=<name>`, `[onesub/mock/<tag>]` →
`[onesub/mock] provider=<tag>`, and `[onesub] <label> pool error` → `[onesub]
Postgres pool error store=<label>`. Every other prefix is unchanged. See
`docs/MIGRATION.md`.

`purchaseToken` and `orderId` are still logged in full on the Google webhook paths
that already logged them, now under those field names — naming them is what makes a
redaction pass expressible, which this release does not do.
