# Migration Guide

Upgrade notes for releases of `@onesub/server` that need one. While the package is pre-1.0, a minor release may narrow behaviour — anything that is not drop-in has an entry here, so check this file for the versions you are skipping.

---

## `@onesub/server` 0.27.x → 0.28.0

Several failures used to be answered with the wrong status, or with one a client could not act
on. Each now has the status that says whose fault it is. None needs a configuration change unless
you run a dev mode in production (first item) or alert on the old codes.

### Breaking: `skipJwsVerification` is refused in production, and `apps[]` is checked too

`createOneSubMiddleware` now **throws at startup** when `NODE_ENV=production` and
`apple.skipJwsVerification` is set. It already threw for `mockMode`. Both checks now cover every
`apps[]` entry as well as the top-level config. Before, a `mockMode: true` on one `apps[]` entry
went straight past the guard, so that app accepted any receipt in production.

**Fix:** remove the flag from production configuration. There is no supported production use for
it: it accepts unsigned Apple receipts and notifications.

### Breaking: the config is validated at startup

`createOneSubMiddleware` now throws at boot, listing every problem, for a config that cannot work.
These used to fail later, per request:

| Config problem | Used to |
|---|---|
| `defaultAppId` naming no app | route every unrouted request to the first app |
| empty `apple.bundleId` | — |
| a `productReceiptMaxAgeHours` that is not positive (`Infinity` is allowed), negative `metricsCacheTtlSeconds`, unknown `refundPolicy` | — |

These only log a warning:
- the same `apps[]` id listed twice (the first entry wins)
- a `google.serviceAccountKey` that is not usable key JSON
- partial Apple API credentials
- a half-set promotional-offer key
- one bundle ID on two apps
 An empty `serviceAccountKey` string still counts as unset. The full list is in
[CONFIGURATION.md](CONFIGURATION.md#startup-validation).

**Fix:** if the server now refuses to start, the message names the field. For the warnings, a key passed
as a file path is the common one: pass the file's contents.

`database` is now optional and deprecated. The server never read it, and a config that set only
`database.url` kept everything in memory. Pass `store` / `purchaseStore`. The package's own
`node dist/index.js` entrypoint now builds Postgres stores from `DATABASE_URL`.

### A store outage is `503 PROVIDER_UNAVAILABLE`, not `422 RECEIPT_VALIDATION_FAILED`

When Google Play cannot answer — 5xx, 429, a timeout, a network failure, or the service account
refused (401/403) — `POST /onesub/validate` and `POST /onesub/purchase/validate` now answer
**503** with the new `PROVIDER_UNAVAILABLE` code. They used to answer 422, which clients treat as
final, so valid purchases were dropped during outages. `MOCK_NETWORK_ERROR` receipts give the same
503 instead of a 500.

The exported `validateGoogleReceipt` keeps its contract: it still returns `null` in these cases, so a
host that calls it directly sees no change. onesub's own routes use an internal variant that throws
`ProviderUnavailableError`, which is exported for hosts that want the distinction.

The Google webhook can now fail a delivery too: for a purchase token the server has never seen, a Play
outage answers 5xx so Pub/Sub redelivers it. Before, the 200 dropped the new subscription. Our own
credentials being refused (401/403) is acknowledged and logged as before, since retrying cannot fix it.

**Fix:** if your client special-cases `RECEIPT_VALIDATION_FAILED`, treat `PROVIDER_UNAVAILABLE` as
retryable. See [RECEIPT-ERRORS.md](RECEIPT-ERRORS.md#provider_unavailable-503).

### Other status corrections

- A purchase whose `transactionId` another request claims concurrently answers **409
  `TRANSACTION_BELONGS_TO_OTHER_USER`**, not 500.
- Two concurrent copies of the same `/onesub/purchase/validate` request no longer both answer
  `action: "new"`. The second waits for the first and answers `restored`, so a consumable is granted
  once. This applies within one server process; separate instances can still race, as in 0.27.
- Admin `reset`, `transfer` and `grant` answer **500 `STORE_ERROR`** on a store failure instead of
  leaving the request unanswered. `grant` with a `transactionId` that another user owns answers
  **409**.
- A malformed JSON body on a `/onesub/*` route answers **400 `INVALID_INPUT`**, and an oversized
  one **413**, with the usual JSON error body instead of Express's HTML page. Every other error still
  reaches your own error handler, as before. `createOneSubServer`, which has no host handler, answers
  those with a JSON 500.
- An Apple summary notification (`RENEWAL_EXTENSION` / `SUMMARY`) is acknowledged with 200 instead
  of crashing the handler.

### Apple `/validate` no longer undoes a refund or ends a grace period early

A receipt is still applied as in 0.27, including moving the subscription to the requesting account.
Two exceptions now keep the stored status, and only while the receipt shows no later expiry. A renewal
or resubscribe is always applied.

- **A refund.** A transaction signed before the refund was recorded still decodes as active, and
  re-posting it used to re-activate the refunded subscription. It no longer does. A transaction signed
  *after* the refund without a revocation means the refund was reversed, and is applied. Records
  written before 0.28 cannot tell the two apart, so they keep the refund, but only for the same product:
  another product in the group is a new purchase.
- **A billing grace period, for the same user.** The transaction alone reads as expired, while Apple
  says to keep providing service through the grace period.

The stored entitlement is never copied onto another account.

### New columns `state_as_of` and `grace_period_expires_at`; out-of-order notifications are ignored

`SubscriptionInfo` gains `stateAsOf`, the time of the newest store-state snapshot applied to the record.
A notification or receipt older than that no longer changes status, expiry or renewal, so a late
EXPIRED or ON_HOLD cannot roll back a renewal or a recovery. See
[ARCHITECTURE.md](ARCHITECTURE.md#ordering-newest-snapshot-wins).

**Postgres:** `initSchema()` adds the column. If your DBAs apply `sql/schema.sql` by hand instead, run:

```sql
ALTER TABLE onesub_subscriptions ADD COLUMN IF NOT EXISTS state_as_of TIMESTAMPTZ;
ALTER TABLE onesub_subscriptions ADD COLUMN IF NOT EXISTS grace_period_expires_at TIMESTAMPTZ;
```

Run it before deploying if your host calls `initSchema()` without awaiting it. Until the columns
exist, the store keeps saving the way 0.27 did: it logs one warning and skips the ordering guard, so
nothing fails. Only the admin metrics query needs the new columns.

Redis and in-memory stores need nothing. A custom `SubscriptionStore` must persist the new field, or
ordering is not enforced for its records.

### Apple grace period grants access; `/onesub/status` looks at every subscription

- **Grace period:** during an Apple billing grace period, the new `gracePeriodExpiresAt` holds when
  the grace period ends, and `isSubscriptionEntitled` / `active` count access until then. Before, a
  `grace_period` record reported `active: false` because its paid period had already ended.
  `expiresAt` is unchanged: it still means "paid through". Hosts that compute billing cycles from it
  are unaffected.
- **Several subscriptions:** `GET /onesub/status` evaluates all of a user's subscriptions and reports the
  most recent one that grants access. Before, it read only the most recently written record, so a webhook
  for an old expired subscription could hide an active one.
- **Replaced Google tokens:** a record that another of the user's records replaced (its token is the
  newer record's `linkedPurchaseToken`) no longer grants access in `/onesub/status` or the entitlement
  routes. Before, after a plan change whose replacement was refunded, the old token could keep access
  alive until its own expiry.

### Every store refuses a second non-consumable row

All three built-in `PurchaseStore`s refuse a second non-consumable row for the same user and product.
They throw `{ code: 'NON_CONSUMABLE_ALREADY_OWNED' }`, and `purchaseConflict()` builds that error.
Postgres already refused it, but with a raw `23505` that surfaced as a 500.

| Route | Answer when the user already owns the non-consumable |
|---|---|
| Purchase validation that loses the race | the recorded copy, `action: "restored"` |
| Admin grant / transfer | 409 |

Redis records the claim under `onesub:purchase:nc:<userId>:<productId>`. A custom `PurchaseStore` should
enforce the same rule. `packages/server/src/__tests__/store-contract.ts` is the executable statement of
the contract.

### BullMQ webhook queue

`BullMQWebhookQueue` job ids changed from `apple:<id>` to `apple-<id>`. BullMQ 5 rejects a custom
id with one `:`, so every enqueue had been failing. No action is needed. A job left over under the
old format would not be deduplicated against a new one, but none could have been created.

---

## `@onesub/server` 0.26.x → 0.27.0

### Breaking: the Google RTDN webhook refuses unauthenticated requests in production

**Who is affected.** A production deployment (`NODE_ENV=production`) where no configured
app sets `google.pushAudience`. `POST /onesub/webhook/google` used to accept those
requests; it now answers **401**. Nothing changes outside production, and nothing
changes if you already set `pushAudience`.

**Fix, in order of preference:**

```ts
// 1. Configure Pub/Sub push authentication — the intended setup.
google: {
  packageName: 'com.example.app',
  pushAudience: 'https://your-server.example.com/onesub/webhook/google',
  pushServiceAccountEmail: 'push@your-project.iam.gserviceaccount.com',
}

// 2. Or state that something in front of the server already authenticates the
//    request — Cloud Run with IAM, a VPC-internal ingress, mTLS at a proxy.
google: { packageName: 'com.example.app', allowUnauthenticatedWebhook: true }
```

Option 2 is not a way to postpone option 1. With neither, an RTDN is accepted from
anyone who can reach the endpoint.

**Why this, and not masking the ids in logs.** The exposure was never forged
entitlement — the subscription paths re-fetch state from Google before writing — but
*revocation*: the voided-purchase path acts on the payload alone, so a caller who knew
a `purchaseToken` or `orderId` could cancel a subscription or delete a one-time
purchase row.

The obvious-looking fix is to stop putting those ids in logs. It does not work. For a
Google subscription the purchase token **is** the record's `originalTransactionId` —
deliberately, because RTDNs and `linkedPurchaseToken` chains carry nothing else — so it
is in the database, in every notification payload, and in the webhook lines where it is
the subject of the investigation. Redacting it from logs would have left the capability
intact while implying it was protected. Refusing requests that cannot be attributed to
Google removes the capability.

**The startup warning changed accordingly.** Where it used to say the endpoint
"accepts unauthenticated requests", it now either says the endpoint *will reject every
request with 401* (no `pushAudience`, no opt-in) or that it *runs unauthenticated by
explicit opt-in*. If you alert on that text, update the pattern.

### Log values are bounded and Play URLs are scrubbed

Two smaller changes, no configuration:

- **Each field value is cut at 512 characters**, with `…+N more` saying how much was
  dropped. This bites on upstream error bodies: `fetchSubscriptionPurchaseV2`
  interpolates the whole Play error body into its `Error` message, so `err.msg` was as
  unbounded as `responseBody`.
- **A purchase token echoed in a Play API URL is replaced** with
  `/tokens/[redacted]`. A Play error body can quote the request URL, which would put
  the token on the acknowledge, consume and validation-failure lines — the ones that
  deliberately log `productId` and `httpStatus` and no token. A `purchaseToken` field
  is *not* masked, for the reason above.

---

## `@onesub/server` 0.25.x → 0.26.0

### The remaining log lines carry `key=value` fields

0.25.0 did this for the Apple and Google providers. This release finishes it: the
routes, the app registry, the webhook handlers, the BullMQ queue and the Postgres
pool. **`userId` becomes filterable for the first time** — it arrives in a request
body, so it exists in the routes and never in the provider layer.

```text
before  [onesub/validate] account binding mismatch for 2000000123: receipt token does not match userId alice
after   [onesub/validate] account binding mismatch — receipt token does not match userId originalTransactionId=2000000123 userId=alice

before  [onesub/purchase] reassigned transaction t_9 from alice to bob
after   [onesub/purchase] reassigned transaction to a new user transactionId=t_9 fromUserId=alice userId=bob

before  [onesub] Multi-app mode: main, eu | default: main
after   [onesub] Multi-app mode appIds="[\"main\",\"eu\"]" defaultAppId=main
```

**Impact.** Only if you match on log *text*. Beyond the fields themselves, three
prefixes changed, because the value in them is now a field:

| before | after |
|---|---|
| `[onesub/metrics/started] error:` | `[onesub/metrics] error route=started` |
| `[onesub/mock/apple] receipt rejected` | `[onesub/mock] receipt rejected provider=apple` |
| `[onesub] PostgresSubscriptionStore pool error (idle client):` | `[onesub] Postgres pool error (idle client) store=PostgresSubscriptionStore` |

Everything else keeps its prefix, so `[onesub/validate]`, `[onesub/webhook/apple]`,
`[onesub/webhook/google]` and `[onesub/admin/…]` greps still match. Trailing colons
are gone from messages that had a value after them.

**Errors.** Every `catch` now passes the `Error` itself, so the stack arrives as
`    | ` continuation lines instead of being flattened — and error lines carry the
request context they were missing (`userId`, `productId`, `platform`,
`notificationUUID`, `messageId`).

**`purchaseToken` and `orderId` are still logged in full**, under those field names,
on the Google webhook paths that already logged them — they are the lookup keys an
operator needs. Naming them is what makes a redaction pass expressible; this release
does not redact. Treat these logs as credential-bearing.

---

## `@onesub/server` 0.24.0 → 0.25.0

### Apple and Google log lines carry `key=value` fields

0.24.0 made every log arrive as one escaped string. This release changes what is
*in* that string for the Apple and Google providers: the message is now a fixed
literal and the values that used to be interpolated into it are named fields.

```text
before  [onesub/apple] Bundle ID mismatch: com.evil !== com.real
after   [onesub/apple] Bundle ID mismatch bundleId=com.evil expected=com.real

before  [onesub/google] Product receipt too old (>72h)
after   [onesub/google] Product receipt too old productId=coins_50 orderId=GPA.1234 maxAgeHours=72 purchaseDate=2026-01-02T03:04:05.000Z
```

**Why.** A value spelled into a sentence cannot be filtered on, so "show me every
rejection for `productId=coins_50`" was not answerable. It also cannot be redacted,
which matters because these lines carry receipt content.

**Impact.** Only if you match on log *text*. Alerts and saved searches that pin the
old wording need updating; the change is mechanical:

- Trailing colons are gone from messages that had a value after them
  (`Bundle ID mismatch:` → `Bundle ID mismatch`).
- Values interpolated into the message are now fields. `(>72h)` became
  `maxAgeHours=72`; `Status API error 503: <body>` became
  `Status API error httpStatus=503 originalTransactionId=… responseBody="<body>"`.
- One message was reworded because the number in it became a field:
  `Transaction History pagination hit the 50-page cap` is now
  `Transaction History pagination hit the page cap` with `maxPages=50`.
- Rejections that previously identified nothing now carry `productId` and, where
  known, `transactionId` / `orderId`.

The `[onesub/apple]` and `[onesub/google]` prefixes are unchanged, so anything
grepping those still matches. Routes, stores and the webhook handlers are not part
of this release and still interpolate; they follow in a later one.

**Still not redacted.** Upstream error bodies are logged under `responseBody`, and a
Google Play error body can echo the request URL, which contains a `purchaseToken` —
a value that is enough to cancel a subscription. Naming the field is what makes
redacting it possible; this release does not redact it. Treat these logs as
credential-bearing.

---

## `@onesub/server` 0.23.x → 0.24.0

### Your log sink now receives one pre-formatted string

`config.logger` previously got printf-style arguments — a message, then whatever
values the call site passed, including raw `Error` objects. It now receives **exactly
one string** per log: the message, contextual values as `key=value` pairs, and any
stack trace as `    | `-prefixed continuation lines.

```text
before  logger.warn('[onesub/apple] Bundle ID mismatch:', 'com.evil', '!==', 'com.real')
after   logger.warn('[onesub/apple] Bundle ID mismatch: com.evil !== com.real')
```

The message text itself is unchanged in 0.24.0 — only the argument count is. Call
sites moved to `key=value` fields in 0.25.0; see the entry below.

**Why.** Values interpolated into a message could not be escaped without also
escaping the message, and a caller-supplied newline in one of them could end the log
line and forge the next — `userId` arrives in a request body, and bundle ids and
purchase tokens are decoded out of submitted receipts and notifications. Passing
values as a trailing object does not fix it either: `console` escapes strings inside
objects, but `pino` treats the object as a printf argument, and a JSON sink drops an
`Error` entirely because its properties are non-enumerable. Rendering in the server
is the only place the guarantee holds for every sink.

**Impact.** If you pass `console`, `pino`, `winston` or `bunyan`, nothing to do — the
string arrives as the message. You are affected if you:

- **Inspected arguments beyond the first.** There is only one now.
- **Relied on receiving the raw `Error`** so your sink could serialise it. The stack
  is now rendered into the string instead. It is still complete and still readable;
  it is no longer an object.
- **Parse onesub log lines.** Contextual values are `key=value` pairs, quoted when
  they contain anything but `[A-Za-z0-9_.:/@+-]`. Logfmt parsers in Loki, Splunk,
  Datadog and CloudWatch Insights extract them as fields.
- **Join multi-line records.** Stack frames are continuation lines beginning with
  four spaces and `| `. Shippers that already join `^\s` to the previous record need
  no change.

**Not the end state.** Fields are text inside the message, not typed JSON fields. A
typed structured sink is a planned follow-up now that the call sites carry
`(message, fields)`; this release is the step that makes the guarantee hold
everywhere first.

---

## `@onesub/server` 0.21.x → 0.22.0

### `POST /onesub/webhook/google` is mounted only when the config serves Google Play

The route used to be mounted unconditionally. It is now registered only when the
config has a top-level `google` block, or a `google` block on any `apps[]` entry.

**Why.** Unlike the Apple webhook, this route does not authenticate
unconditionally — the Pub/Sub OIDC token is verified only when an app declares a
`pushAudience` — and its `voidedPurchaseNotification` branch needs no Google
credentials to run: it cancels a subscription by `purchaseToken`, or deletes a
one-time purchase row by `orderId`, straight from the payload. An Apple-only
deployment therefore exposed an unauthenticated endpoint that could revoke
entitlement, with no Google purchases for it to be about.

**Impact.** If you serve Google Play, nothing changes. If you do not, requests to
that path now get `404` instead of being processed, and you no longer need to block
it at your proxy. Drop any monitoring that expects a 2xx/4xx there.

The Apple webhook remains unconditional: it verifies the `signedPayload` JWS
against the bundled Apple roots on every request regardless of config, so it is not
open in the same way.

Configuring Google without a `packageName` still mounts the route and still runs it
in legacy open mode (any package accepted). Since `0.21.2` the server warns at
startup about that and about a missing `pushAudience` when `NODE_ENV=production`.

---

## `@onesub/server` 0.14.x → 0.15.0

### Google subscription records are now keyed by `purchaseToken`

Previously `validateGoogleReceipt` stored records with `originalTransactionId = latestOrderId` (`GPA.…`). RTDN webhooks and `linkedPurchaseToken` chains only carry the **purchaseToken**, so webhook lookups never found those records — refunds, cancellations, and renewals silently failed to update them. Records are now keyed by the purchaseToken itself.

**Impact on existing deployments:** records created by older versions (keyed by order id) will not be found by webhook lookups — same as before the fix — but the next successful `POST /onesub/validate` for that user re-creates the record under the token key, after which the full lifecycle works. The stale order-id record ages out at its `expiresAt`. If you want to migrate eagerly, re-validate stored receipts or delete rows whose `original_transaction_id` starts with `GPA.`.

### Subscription validation now enforces account binding

`POST /onesub/validate` now rejects (409 `TRANSACTION_BELONGS_TO_OTHER_USER`) a receipt whose embedded account identity (Apple `appAccountToken` / Google `obfuscatedExternalAccountId`) does not match the request `userId` — the same guard `POST /onesub/purchase/validate` gained in 0.13. Receipts without an embedded token keep the legacy rebind behavior.

### `CONSUMPTION_REQUEST` no longer revokes

Apple's `CONSUMPTION_REQUEST` (refund **review** request) previously deleted consumable purchase rows and canceled subscriptions immediately. It now leaves state untouched; the actual `REFUND`/`REVOKE` notification (sent if Apple grants the refund) performs the revocation.

---

## `@onesub/server` 0.11.x → 0.12.0

**Zero breaking changes.** All new options are optional — existing code works unchanged after `npm update @onesub/server`.

### What's new (all opt-in)

#### 1. Redis-backed stores (multi-instance)

```bash
npm install ioredis
```

```ts
import Redis from 'ioredis';
import {
  RedisSubscriptionStore,
  RedisPurchaseStore,
  RedisCacheAdapter,
  RedisWebhookEventStore,
} from '@onesub/server';

const redis = new Redis(process.env.REDIS_URL!);

app.use(createOneSubMiddleware({
  // ...existing config unchanged...
  store:             new RedisSubscriptionStore(redis),
  purchaseStore:     new RedisPurchaseStore(redis),
  cache:             new RedisCacheAdapter(redis),
  webhookEventStore: new RedisWebhookEventStore(redis),
}));
```

- `cache` — shares Apple JWT assertions and Google OAuth tokens across cluster nodes so each node doesn't mint independently.
- `webhookEventStore` — deduplicates Apple `notificationUUID` and Google `messageId` with an atomic Redis `SET NX` before any state mutation.

#### 2. Durable webhook queue (BullMQ)

```bash
npm install bullmq ioredis
```

```ts
import { BullMQWebhookQueue } from '@onesub/server';
import Redis from 'ioredis';

const connection = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });

app.use(createOneSubMiddleware({
  // ...
  webhookQueue: new BullMQWebhookQueue({ connection }),
  adminSecret: process.env.ADMIN_SECRET,
}));
```

Adds two admin endpoints (require `adminSecret`):
- `GET  /onesub/admin/webhook-deadletters`
- `POST /onesub/admin/webhook-replay/:id`

#### 3. OpenAPI document

```ts
import { ONESUB_OPENAPI, openapiHandler } from '@onesub/server';

app.get('/openapi.json', openapiHandler());
```

#### 4. OpenTelemetry tracing

Install `@opentelemetry/api` alongside any OTel SDK — spans appear automatically. Zero overhead when the package is absent.

#### 5. Dual ESM + CJS build

`dist/index.js` (ESM) and `dist/index.cjs` (CJS) are now both published. The `exports` map in `package.json` routes `import` and `require` correctly — no host-side change needed.

### `@onesub/shared` 0.7.4 → 0.7.5

`AppleNotificationPayload` now exposes `notificationUUID?: string` — the top-level field Apple stamps on every App Store Server Notification. Used internally by `RedisWebhookEventStore` / `CacheWebhookEventStore` for dedup.

---

## `@onesub/server` 0.7.x → 0.9.x

Two minor releases in one window. Almost no host code change; the visible changes are **new lifecycle states**, **new opt-in config options**, and **two auto-backfilled Postgres columns**.

### What changed

**1. Lifecycle states added** (`@onesub/shared` 0.4.0 + 0.5.0):

`SubscriptionStatus` gained three values:
- `grace_period` — payment failed but Apple/Google still grants access (Apple `DID_FAIL_TO_RENEW` + `GRACE_PERIOD` subtype, Google `IN_GRACE_PERIOD`)
- `on_hold` — grace ended, billing retry continues, entitlement REVOKED (Apple post-`GRACE_PERIOD_EXPIRED`, Google `ON_HOLD`)
- `paused` — user-voluntary pause (Google only); resumes at `autoResumeTime`

The `/onesub/status` route's `active: boolean` continues to work — it now treats `grace_period` as active and additionally checks `expiresAt > now` (stale-record safety + natural expiry for `until_expiry` refunds).

**2. Webhook lifecycle classification fixed**:
- Google: `IN_GRACE_PERIOD` (6) was previously misclassified as `active`; `ON_HOLD` (5) was unhandled. Now both map correctly.
- Apple: `DID_FAIL_TO_RENEW` + `GRACE_PERIOD_EXPIRED` are now mapped explicitly (previously fell through to JWS-derived status).
- Google: `validateGoogleReceipt` returns `'paused'` for `SUBSCRIPTION_STATE_PAUSED` (previously returned `'on_hold'` — see PR #29).

**3. Google Play Developer API v1 → v2** (`subscriptionsv2.get`):
Internal change. The v2 endpoint returns explicit `subscriptionState` enum strings instead of having to infer from `expiryTime`/`cancelReason`, which is what enables the correct grace/hold/paused classification above.

**4. Two auto-backfilled Postgres columns**:
- `onesub_subscriptions.linked_purchase_token TEXT`
- `onesub_subscriptions.auto_resume_time TIMESTAMPTZ`

`store.initSchema()` runs `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` on the next startup. No manual migration needed.

**5. New opt-in config options** — all default to off; existing behavior unchanged.

### You're affected if

- You `switch (status)` exhaustively on `SubscriptionStatus`. The new values will need cases (TS will tell you).
- You read `validateGoogleReceipt` output and compare the `status` string for `SUBSCRIPTION_STATE_PAUSED`-derived records. They now arrive as `'paused'` instead of `'on_hold'`.
- You run a manually-applied schema (you don't call `store.initSchema()`). Add the two columns yourself or call `initSchema()` once on next deploy.

### You're NOT affected if

- You only check `isActive` (the SDK / status route's `active` boolean). The new states fold into the same active/not-active answer correctly.
- You let `PostgresSubscriptionStore.initSchema()` run at boot.

### Action

```bash
npm install @onesub/server@^0.9 @onesub/shared@^0.5
```

Optional follow-ups:

```ts
// Goodwill refund: keep entitlement until expiry
{ refundPolicy: 'until_expiry' }

// Apple App Store Server API features (status fetch fallback + consumption response)
apple: { keyId, issuerId, privateKey, consumptionInfoProvider: ... }

// Google price-change analytics
google: { onPriceChangeConfirmed: (ctx) => analytics.track(...) }
```

### New behaviors to verify in sandbox

The internal hardening (Apple JWT cache, fetch timeouts) is transparent. The lifecycle reclassification is not — verify:

1. Apple billing retry: `SUBSCRIBED → DID_FAIL_TO_RENEW(GRACE) → GRACE_PERIOD_EXPIRED → DID_RENEW`
2. Google paused: `PURCHASED → PAUSED → RESTARTED` (`autoResumeTime` populated while paused)
3. Google plan upgrade: new token's `linkedPurchaseToken` correctly inherits the previous `userId`
4. Apple subscription `REFUND` with `refundPolicy: 'immediate'` (default) flips to `canceled` immediately
5. Apple webhook for an unknown `originalTransactionId` triggers Status API fallback (with API creds)

---

## `@onesub/server` 0.6.x → 0.7.0

**What changed:** `express`가 `dependencies`에서 **`peerDependencies`로 이동**. 더 이상 `@onesub/server`가 자체 express 사본을 끌고 들어오지 않음.

지원 범위: `"^4.17.0 || ^5.0.0"` — Express 4 또는 5 모두 호환.

**Why:** middleware 라이브러리의 표준 패턴. 호스트 앱이 이미 가진 express 인스턴스와 `@onesub/server`의 Router가 같은 인스턴스를 공유하게 됨 (이중 설치 / 인스턴스 mismatch 방지).

**You're affected if:**
- `@onesub/server`만 설치하고 호스트 앱에 `express`가 없었던 경우 — install이 peer warning을 띄움. 거의 없는 케이스 (express 없이 이 미들웨어를 쓸 일이 없음).

**Action:**
```bash
npm install express          # 호스트 앱에 명시적으로 설치 (이미 있으면 no-op)
npm install @onesub/server@latest
```
- Express 4 사용자: `npm install express@^4.17.0` 후 `@onesub/server@^0.7.0` 설치 — 그대로 작동
- Express 5 사용자: `npm install express@^5` 후 동일

내부 구현은 Express 4/5 공통 API만 사용 (`Router`, `express.json`, 표준 `(req, res, next)`). 이전 0.6.4의 Express 5 강제 의존성은 풀림.

---

## `@onesub/server` 0.6.3 → 0.6.4 (지금은 0.7.0으로 직행 추천)

**What changed:** Internal upgrade from Express 4 to Express 5 — but this version pinned `express` as a regular `dependencies`. **0.7.0이 이 문제를 해결**하므로 0.6.3 사용자는 0.6.4를 건너뛰고 0.7.0으로 직행 권장.

**호환성 메모:** 0.6.4의 Router는 express 5 인스턴스를 사용. 호스트 앱이 express 4면 `(req, res, next)` 미들웨어 시그니처는 호환되지만 Router-level error handler 체인이 분리될 수 있음.

---

## `@onesub/server` 0.5.x → 0.6.x

**What changed:** Apple JWS verification now walks the full `x5c` certificate chain up to a bundled Apple Root CA (G3). Previously only the leaf certificate was used to verify the signature, so a self-signed cert could mint a JWS that passed.

**You're affected if:**
- You generate test JWS with a non-Apple-issued key in CI / local tests.
- You proxy receipts through a system that re-signs them.

**You're not affected if:**
- Your server only receives real receipts from `react-native-iap` (StoreKit 2) in production or sandbox.

**Action:**
- Production: no change required.
- Tests: stop minting fake JWS with self-signed certs. Use StoreKit 2 sandbox receipts, or mock the provider (`validateAppleConsumableReceipt`) directly.
- When Apple publishes Root CA G4, add its PEM to `packages/server/src/providers/apple-root-ca.ts` — both roots will be accepted simultaneously.

---

## `@onesub/server` 0.4.x → 0.5.x

**What changed:** `POST /onesub/purchase/validate` now rejects a `transactionId` that is already owned by a different `userId` instead of silently no-op'ing.

Previously `savePurchase` used `ON CONFLICT (transaction_id) DO NOTHING`, so the same Apple/Google `transactionId` submitted under a different `userId` would be silently dropped while the server still returned `valid: true`. This let a single receipt be reused across arbitrary accounts.

**New behavior:**
- Same `userId` + same `transactionId` → idempotent no-op (unchanged).
- Different `userId` + same `transactionId` → `HTTP 409 { error: 'TRANSACTION_BELONGS_TO_OTHER_USER' }`.
- Non-consumables only: `0.6.1+` auto-reassigns instead of rejecting, because a valid JWS (verified against Apple Root CA as of `0.6.0`) proves the caller owns the Apple account. Consumables still reject.

**You're affected if:**
- Your app reuses a cached `userId` across device reinstalls or multiple logins and previously depended on silent-skip behavior. You'll now see `409` on what used to succeed.
- You run integration tests that feed the same `transactionId` under rotating `userId`s.

**Action:**
- App: handle `409 TRANSACTION_BELONGS_TO_OTHER_USER` by showing a "이 구매는 다른 계정에 연결되어 있습니다" dialog, or upgrade to `>= 0.6.1` so non-consumable reinstalls auto-resolve.
- For legitimate device/account migrations, call the new admin endpoint:
  ```bash
  curl -X POST https://api.yourapp.com/onesub/purchase/admin/transfer \
    -H "X-Admin-Secret: $ADMIN_SECRET" \
    -H "Content-Type: application/json" \
    -d '{"transactionId":"<apple-or-google-tx>","newUserId":"new-user-id"}'
  ```
- Set `config.adminSecret` to enable `/onesub/purchase/admin/*` routes. If unset, the admin router is not mounted.

---

## React Native SDK 0.2.x → 0.3.x

**What changed:**

1. **The package was renamed** from `@onesub/sdk` to **`@jeonghwanko/onesub-sdk`** in this release.
   `@onesub/sdk` receives no further updates. Every version from 0.3.0 onward is published under the
   new name; all other documentation refers to it that way.
2. `react-native-iap` peer dependency bumped to **v15**. v15 switched from promise-returning
   `requestPurchase()` to an event-based model (`purchaseUpdatedListener`). The SDK now uses the new
   pattern internally.

**Action:**
- `npm uninstall @onesub/sdk && npm i @jeonghwanko/onesub-sdk`, and update your import specifiers.
- `npm i react-native-iap@^15` in your app.
- No other source change required if you only use `useOneSub()` — the pattern change is internal.

---

## `@onesub/shared` 0.2.x → 0.3.x

Additive only. `ValidatePurchaseResponse.action?: 'new' | 'restored'` added in `0.3.1` — optional, safe to ignore on the client.
