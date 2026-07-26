---
'@onesub/server': minor
---

Move Apple and Google provider log values out of the message and into named
`key=value` fields.

The 49 `log.*` call sites in `providers/apple.ts` and `providers/google.ts` now pass
a static message plus a fields object, so `productId`, `originalTransactionId`,
`httpStatus`, `bundleId` and friends can be filtered on instead of being spelled
into a sentence. Rejections that previously identified nothing — "Purchase was
revoked/refunded", "No transactionId in consumable transaction" — now name the
product and transaction they refused. Error paths pass the `Error` itself rather
than `err.message`, so the stack survives as continuation lines.

Log *text* changes for these two providers; the `[onesub/apple]` and
`[onesub/google]` prefixes do not. See `docs/MIGRATION.md` for the before/after and
the two reworded messages. Routes, stores and webhook handlers still interpolate and
follow separately.

Adds a source-scanning test that holds every `log.*` call site in the package to the
field vocabulary declared in `log-format.ts`, because per-site assertions do not
scale to ~100 sites — a rename of `productId` to `product` at one un-asserted site
passed the whole suite before it existed.
