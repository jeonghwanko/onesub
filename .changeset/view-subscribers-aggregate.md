---
"@onesub/mcp-server": patch
---

`onesub_view_subscribers` now actually returns aggregate subscriber data. New optional `adminSecret` input (sent as `x-admin-secret`): when `userId` is omitted and `adminSecret` is provided, the tool calls `GET /onesub/metrics/active` and renders active-subscriber counts (total / active / grace-period / lifetime purchases, plus product & platform distributions) and a first page of `GET /onesub/admin/subscriptions` as a compact table. Without a secret, the guidance no longer falsely claims the server "does not expose" a list endpoint (or suggests querying the DB directly) — it names the gated endpoints and the `adminSecret` argument to pass. The per-user status path (`userId` given) is unchanged and still needs no secret.
