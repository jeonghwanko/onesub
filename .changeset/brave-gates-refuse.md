---
'@onesub/shared': minor
'@onesub/server': minor
---

**Breaking in production:** `POST /onesub/webhook/google` now answers 401 when no
configured app sets `google.pushAudience`, instead of accepting the request. Adds
`google.allowUnauthenticatedWebhook` for deployments that authenticate the request in
front of the server (Cloud Run IAM, VPC-internal ingress, mTLS at a proxy). Nothing
changes outside `NODE_ENV=production`, matching how the mockMode guard and
sandbox-receipt rejection are gated.

The exposure this closes was entitlement *revocation*, not forged entitlement: the
voided-purchase RTDN path acts on the payload alone, so a caller who knew a
`purchaseToken` or `orderId` could cancel a subscription or delete a one-time purchase
row.

Masking those ids in logs — the obvious-looking fix — does not work. For a Google
subscription the purchase token **is** the record's `originalTransactionId`,
deliberately, because RTDNs and `linkedPurchaseToken` chains carry nothing else. It is
in the database, in every notification payload, and in the webhook lines that
investigate it. Redacting it from logs would have left the capability intact while
implying it was protected.

The startup warning now distinguishes "will reject every request with 401" from "runs
unauthenticated by explicit opt-in"; update any alert matching the old wording.

Also, with no configuration: each log field value is cut at 512 characters with
`…+N more` (an upstream Play error body was interpolated whole into an `Error`
message, so `err.msg` was unbounded), and a purchase token echoed inside a Play API
URL is replaced with `/tokens/[redacted]` so it cannot reach the acknowledge, consume
and validation-failure lines that carry no token field.
