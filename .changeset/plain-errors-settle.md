---
'@onesub/server': patch
---

Stop 500 responses from describing the server, and unify input validation.

Seven handlers forwarded `(err as Error).message` straight to the caller on a 500
— six admin routes and the Apple promotional-offer route. With a Postgres store
that means the driver's message, which can carry the host, port, role name, and
fragments of the failing statement. The offer route is the worst of them: it signs
with the promotional-offer private key, so a JOSE or crypto failure message was the
last thing to hand back. All seven now log the real error server-side through the
configured logger and return a generic message. `errorCode` is unchanged, so
programmatic handling is unaffected — it was always the machine-readable contract.

Input validation went through a new internal `parseOrSend` helper. The routes had
three different shapes for the same job: a `try/catch` that re-threw non-zod errors
(correct, five lines, repeated a dozen times), a `try/catch {}` that swallowed
everything into one generic 400, and `safeParse`. The swallowing variant was the
actual defect — a bug inside a schema, such as a throwing transform, was reported
to the caller as "400 bad input", which is both the wrong status and hides the
cause. The helper keeps the correct behaviour and makes it the short one: zod
failures become a 400, anything else propagates.

Each route keeps the error response it had. Routes that returned per-issue zod
detail still do; routes that returned a single fixed message still do; and the
route-specific shape on the error path (`subscription: null`, `purchases: []`, and
so on) is preserved. Route handlers lost about 80 lines net.
