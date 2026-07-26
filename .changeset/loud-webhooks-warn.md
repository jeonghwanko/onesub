---
'@onesub/server': patch
---

Warn at startup when the Google RTDN route is left open.

`POST /onesub/webhook/google` verifies the Pub/Sub OIDC token only when a
configured app declares `pushAudience`; with none declaring one, the verification
step is skipped and the route accepts any well-formed notification body. Separately,
when no app declares `google.packageName` the route runs in legacy open mode and
serves notifications for any package. The route is mounted whether or not Google is
configured at all, so an Apple-only deployment has both conditions.

Neither is new, and `SECURITY.md` mentioned the `pushAudience` condition — but not
its consequence, and nothing said so at runtime. The consequence is narrower than it
first looks and worth stating precisely: the subscription paths re-fetch state from
Google before writing, so a forged notification cannot fabricate an entitlement. The
voided-purchase path does not re-fetch. It acts on the payload alone, setting a
subscription to `canceled` by `purchaseToken` or deleting a one-time purchase row by
`orderId`. So the exposure is entitlement *revocation* by a caller who knows or
guesses one of those ids.

`createOneSubMiddleware` now logs a warning through the configured logger for each
condition. It warns rather than refusing, because rejecting would break deployments
that legitimately front the route with their own Pub/Sub verification — changing that
default is a breaking change and belongs in its own release. Gated on
`NODE_ENV=production`, matching the existing mockMode guard: neither condition is
meaningful locally, where no real notification arrives, and an unconditional warning
would fire on nearly every test and drown itself out.

`SECURITY.md` and `DEPLOYMENT.md` now state the consequence rather than only the
condition.
