# Architecture

## Package Dependency Graph

```
@onesub/providers (standalone product-management API wrappers)
    ↑
    └── @onesub/mcp-server

@onesub/shared (canonical contracts; no OneSub package dependencies)
    ↑
    ├── @onesub/server
    │       ↑
    │       └── @onesub/cli (also depends directly on shared)
    ├── @jeonghwanko/onesub-sdk
    ├── @onesub/mcp-server
    └── @onesub/dashboard

com.onesub.unity ──HTTP──> @onesub/server
    ↑
    └── com.onesub.unity.platform-services
```

No circular dependencies. The SDK and server share contracts but do not depend on one another. The
dashboard and Unity SDK consume the server over HTTP. Unity packages are UPM packages and are not
part of the npm workspace graph.

## SSOT Rules

| Concept | Single Source | Consumers |
|---------|-------------|-----------|
| Route paths | `shared/constants.ts` → `ROUTES` | server routes, SDK api.ts, MCP check-status |
| Subscription status | `shared/constants.ts` → `SUBSCRIPTION_STATUS` | server providers, webhook handlers, status route |
| Status type | `shared/types.ts` → `SubscriptionStatus` | all packages |
| Apple/Google config | `shared/types.ts` → `OneSubServerConfig` | server providers use `NonNullable<Config['apple']>` |
| Default port | `shared/constants.ts` → `DEFAULT_PORT` | server, MCP tools |
| SDK hook API | `sdk/useOneSub.ts` → `useOneSub()` | MCP code generation must match |
| Error codes | `shared/constants.ts` → `ONESUB_ERROR_CODE` | server responses, SDK errors, host applications |
| Multi-app selection | `server/apps.ts` → `getAppRegistry()` | validation and webhook routes |
| OpenAPI contract | `server/openapi.ts` → `ONESUB_OPENAPI` | host applications and generated clients |

## Server Middleware Architecture

```
createOneSubMiddleware(config)
  └── Express Router
      ├── express.json({ limit: '50kb' })
      │
      │── Subscriptions:
      ├── POST /onesub/validate           → zod → provider.validate → subscriptionStore.save
      │                                     (Google: acknowledgeGoogleSubscription fire-and-forget)
      ├── GET  /onesub/status             → subscriptionStore.getByUserId
      │                                     → active = (active|grace_period) && expiresAt > now
      ├── POST /onesub/webhook/apple      → JWS verify → decode → mapAppleNotificationStatus
      │                                     → IAP REFUND/REVOKE: purchaseStore.delete
      │                                     → Sub: refundPolicy gating → store.save
      │                                     → CONSUMPTION_REQUEST: consumptionInfoProvider hook
      │                                       → sendAppleConsumptionResponse PUT
      │                                     → unknown originalTransactionId + creds:
      │                                       fetchAppleSubscriptionStatus → store.save
      ├── POST /onesub/webhook/google     → JWT verify → decode
      │                                     → voidedPurchaseNotification:
      │                                       productType=1 → sub status update (refundPolicy)
      │                                       productType=2 → purchaseStore.delete
      │                                     → subscriptionNotification:
      │                                       lifecycle map (active/grace_period/on_hold/paused/...)
      │                                       → fresh re-fetch via subscriptionsv2.get
      │                                       → store.save (linkedPurchaseToken continuity)
      │                                     → PRICE_CHANGE_CONFIRMED: onPriceChangeConfirmed hook
      │
      │── One-time Purchases:
      ├── POST /onesub/purchase/validate  → zod → provider.validate → purchaseStore.save
      │                                     (Google consumable: consumeGoogleProductReceipt fire-and-forget)
      │                                     (Google non-consumable: acknowledgeGoogleProduct fire-and-forget)
      ├── GET  /onesub/purchase/status    → getPurchasesForProduct (with ?productId)
      │                                     else getPurchasesByUserId → { purchases }
      │
      │── Entitlements (only if config.entitlements is set):
      ├── GET  /onesub/entitlement        → evaluate one configured entitlement
      ├── GET  /onesub/entitlements       → evaluate every configured entitlement
      │
      │── Apple offer signing (only if offerKeyId + offerPrivateKey are set):
      ├── POST /onesub/apple/offer-signature → sign StoreKit promotional offer payload
      │
      └── Admin and metrics (only if config.adminSecret is set; requires X-Admin-Secret):
          ├── DELETE /onesub/purchase/admin/:userId/:productId   → purchaseStore.deletePurchases
          ├── POST   /onesub/purchase/admin/grant                → purchaseStore.savePurchase
          ├── POST   /onesub/purchase/admin/transfer             → purchaseStore.reassignPurchase
          ├── GET    /onesub/admin/subscriptions                 → filtered/paginated subscriptions
          ├── GET    /onesub/admin/subscriptions/:transactionId  → subscription detail
          ├── GET    /onesub/admin/customers/:userId             → customer profile
          ├── POST   /onesub/admin/sync-apple/:originalTransactionId → Apple Status API sync
          ├── GET    /onesub/admin/test-overrides                → list sandbox overrides
          ├── PUT    /onesub/admin/test-overrides/:userId        → force entitlement (Sandbox only)
          ├── DELETE /onesub/admin/test-overrides/:userId        → clear it
          ├── GET    /onesub/admin/webhook-deadletters           → failed BullMQ jobs
          ├── POST   /onesub/admin/webhook-replay/:id            → replay a failed job
          └── GET    /onesub/metrics/*                            → active/started/expired counts
```

All runtime logging goes through `config.logger` (OneSubLogger interface; defaults to `console`). Providers and routes import `log` from the internal `logger.ts` singleton instead of calling `console.*` directly. `logger.ts` renders each call through `log-format.ts` and hands the sink exactly one string: the message, contextual values as `key=value` pairs, and any stack as `    | ` continuation lines. That is what keeps a caller-supplied newline from starting a line on every sink and not just on `console`.

All outbound HTTP calls (Apple Status/History APIs, Apple Consumption Response, Google
subscriptionsv2, Google OAuth, Google ack/consume) go through `http.ts/fetchWithTimeout` —
`AbortController` with a 10s default budget so a hung upstream cannot pile up handlers.

### Multi-app Resolution

`OneSubServerConfig.apps` lets one process serve multiple Apple bundle IDs and Google package names.
The legacy top-level `apple` and `google` configuration remains the single-app/default path.

`server/apps.ts` resolves requests in this order:

1. Explicit request `appId` (also accepts a configured bundle ID or package name).
2. Apple bundle ID decoded from the receipt, followed by normal cryptographic verification.
3. `defaultAppId`, the legacy top-level config, or the only configured app.

Google purchase tokens do not contain a package name, so non-default Google apps must send `appId`.
Unknown explicit identifiers fail closed by returning a config with no provider; they never fall back
to another app's credentials.

## Store Interfaces

### SubscriptionStore (auto-renewable subscriptions)

```ts
interface SubscriptionStore {
  save(subscription: SubscriptionInfo): Promise<void>;
  getByUserId(userId: string): Promise<SubscriptionInfo | null>;
  getByTransactionId(txId: string): Promise<SubscriptionInfo | null>;
  getAllByUserId(userId: string): Promise<SubscriptionInfo[]>;
  listAll(): Promise<SubscriptionInfo[]>;
  listFiltered(options: ListFilteredOptions): Promise<ListFilteredResult>;
  // 0.23.0+, all optional — metrics aggregates
  aggregateActive?(now: Date): Promise<ActiveSubscriptionAggregate>;
  aggregateStarted?(query: MetricsRangeQuery): Promise<MetricsRangeAggregate>;
  aggregateExpired?(query: MetricsRangeQuery): Promise<MetricsRangeAggregate>;
}
```

### PurchaseStore (consumable + non-consumable)

```ts
interface PurchaseStore {
  savePurchase(purchase: PurchaseInfo): Promise<void>;
  getPurchasesByUserId(userId: string): Promise<PurchaseInfo[]>;
  getPurchasesForProduct?(userId: string, productId: string): Promise<PurchaseInfo[]>; // 0.21.0+, optional
  getPurchaseByTransactionId(txId: string): Promise<PurchaseInfo | null>;
  listAll(): Promise<PurchaseInfo[]>;
  hasPurchased(userId: string, productId: string): Promise<boolean>;
  reassignPurchase(transactionId: string, newUserId: string): Promise<boolean>;       // 0.6.1+
  deletePurchases(userId: string, productId: string): Promise<number>;                // 0.4.0+
  deletePurchaseByTransactionId(transactionId: string): Promise<boolean>;             // 0.8.0+
  // 0.23.0+, all optional — metrics aggregates
  aggregateNonConsumable?(): Promise<NonConsumablePurchaseAggregate>;
  aggregateStarted?(query: MetricsRangeQuery): Promise<MetricsRangeAggregate>;
}
```

### Metrics aggregation

The `aggregate*` methods are optional on both stores. `/onesub/metrics/*` uses a
store's own aggregate when it has one and otherwise reads every row and reduces in
process — the same answer at O(rows), on the event loop.

`PostgresSubscriptionStore` / `PostgresPurchaseStore` implement them as `GROUP BY`,
so the work is bounded by products × platforms (× days when bucketing) rather than by
row count. The in-memory and Redis stores deliberately do not: neither has
server-side grouping to push into, so an implementation there would be the same
in-process reduction behind a longer interface.

`packages/server/src/metrics-aggregate.ts` is the executable definition of what the
numbers mean, for both paths. `postgres-store.test.ts` runs the SQL and the reducer
over the same rows and asserts they agree — including UTC calendar-day bucket
boundaries, which is why the SQL casts with `AT TIME ZONE 'UTC'` before
`date_trunc`, and one test forces a non-UTC session so a UTC-only CI container
cannot hide a missing cast.

Both read methods return **most-recent-first** by `purchasedAt`. All three built-in
stores agree on that; a custom store should too, since `/onesub/purchase/status`
surfaces the order directly.

`getPurchasesForProduct` is optional. Non-consumable validation and
`/onesub/purchase/status?productId=` use it when present and otherwise read the
full history and filter in process — correct either way, but the unscoped read
transfers every row a user owns, so an account with a long consumable history paid
for all of them on each lifetime-product purchase. The built-in stores serve it
from an index (`WHERE user_id = $1 AND product_id = $2` in Postgres, the
`user_product` set in Redis). It is optional so that custom `PurchaseStore`
implementations written before it existed keep compiling.

`deletePurchaseByTransactionId` is the precise single-row removal used by IAP refund paths (Apple `REFUND`/`REVOKE` for `Consumable`/`Non-Consumable`, Google `voidedPurchaseNotification` `productType=2`). Distinct from `deletePurchases(userId, productId)` which wipes all rows for that pair — using the userId/productId variant on a refund would also remove sibling consumable purchases the user still owns.

### SubscriptionInfo extra fields

```ts
interface SubscriptionInfo {
  // ...existing fields
  linkedPurchaseToken?: string;   // Google plan upgrade chain (0.8.0+, populated only when chain exists)
  autoResumeTime?: string;        // RFC3339, populated only when status === 'paused' (0.9.0+)
}
```

Postgres columns added in `0.8.0` (`linked_purchase_token`) and `0.9.0` (`auto_resume_time`) are auto-backfilled by `initSchema()` via `ALTER TABLE IF NOT EXISTS` — safe to upgrade in place.

Implementations:
- `InMemorySubscriptionStore` / `InMemoryPurchaseStore` — development/testing only
- `PostgresSubscriptionStore` / `PostgresPurchaseStore` — durable SQL storage (raw pg, UPSERT, auto-schema)
- `RedisSubscriptionStore` / `RedisPurchaseStore` — multi-instance Redis storage

Short-lived provider credentials use the separate `CacheAdapter` abstraction. Built-in in-memory
and Redis cache adapters are also used by webhook idempotency stores. Webhook processing is
synchronous by default; `InProcessWebhookQueue` or `BullMQWebhookQueue` can move state mutation out
of the request path. BullMQ jobs that exhaust retries are exposed through the admin dead-letter APIs.

### Non-consumable Duplicate Prevention

PostgreSQL enforces a partial unique index:
```sql
CREATE UNIQUE INDEX idx_onesub_purchases_non_consumable
  ON onesub_purchases (user_id, product_id)
  WHERE type = 'non_consumable';
```
Application-level `hasPurchased()` check is a fast path; the DB constraint is the atomic guarantee.

## SDK Purchase Flow (client)

The React Native SDK is split so the decision logic is testable without a native module:
`packages/sdk/src/purchaseFlow.ts` holds pure functions (in-flight registry, event handling, native
error mapping, purchase-type resolution), and `packages/sdk/src/OneSubProvider.tsx` holds the React
state and `react-native-iap` wiring. New logic belongs in `purchaseFlow.ts`.

**One listener pair per mount.** `purchaseUpdatedListener` / `purchaseErrorListener` are registered
once at provider mount, *before* `initConnection()` — RN-IAP can emit queued StoreKit transactions
while initialization is still resolving. Registration is repeated after init for the case where the
pre-init subscription was inert; RN-IAP fans out through a Set, so the retry does not double-deliver.

**Drain window.** For a short window after mount, in-flight matching is suppressed. Transactions the
store replays at launch are therefore handled as orphans (validated and finished silently) instead of
resolving a purchase the user has not made yet — the fix for the "sheet never appears, app reports
success" class of bug. `subscribe()` awaits the drain before requesting a purchase.

**In-flight registry.** A `Map<productId, InFlightEntry>` correlates the promise returned to the
caller with the event the store delivers later. Each entry records its kind (`subscription` or
`purchase`) and, for one-time products, the caller's declared type. A second registration for the
same `productId` is refused with `CONCURRENT_PURCHASE`.

**Event handling** (`handlePurchaseEvent`), for both matched events and orphan replays:

1. Classify: `isSubscriptionEvent()` trusts the in-flight entry, then the transaction's
   `productType`; it never guesses "subscription" for an unmatched event.
2. For one-time products, `resolvePurchaseType()` prefers the caller's declared type, then
   `config.consumableProductIds`, then `non_consumable`. This is why hosts that sell consumables must
   declare them: an orphan replay has nothing else to read, and a wrong answer both records the wrong
   `type` server-side and acknowledges instead of consuming on Android.
3. Validate against the server, then `finishTransaction` **only on success** — a rejected receipt is
   left unfinished so the store replays it, and the validation routes are idempotent.
4. Settle the in-flight promise. Subscriptions resolve as soon as validation passes and hand native
   cleanup back to the provider, which keeps the SDK-wide busy lock held until cleanup settles.

**Error contract.** Native codes are normalized (legacy `E_*` and OpenIAP spellings) by
`mapNativePurchaseErrorCode`: cancels become `USER_CANCELLED`, already-owned becomes
`NON_CONSUMABLE_ALREADY_OWNED` for non-consumables only, everything else `INTERNAL_ERROR`.
A `duplicate-purchase` native error is ignored outright — RN-IAP emits it only after it already
delivered the original event, and rejecting on it would strand a paid transaction. Server
`errorCode`s are preserved when a validation failure is rethrown. See
[`../packages/sdk/README.md`](../packages/sdk/README.md) for which calls return `null` and which
throw.

## MCP Tool Design

The registered tools return MCP text content:
- `onesub_setup` — generates integration code matching actual SDK API (`useOneSub`)
- `onesub_add_paywall` — generates paywall component (3 styles)
- `onesub_check_status` — live API call to server
- `onesub_troubleshoot` — pattern-matching diagnostics
- `onesub_create_product` — create products on App Store Connect / Google Play via API
- `onesub_list_products` — list registered products from stores
- `onesub_manage_product` — update product display names or delete products
- `onesub_view_subscribers` — query subscriber status
- `onesub_simulate_purchase` — exercise mock receipt validation without store credentials
- `onesub_simulate_webhook` — send lifecycle webhook fixtures to a development server
- `onesub_inspect_state` — inspect a user's subscription and purchase state

Product-management tools delegate to `@onesub/providers`; integration/simulation tools use shared
contracts and the public server HTTP surface. Generated output is regression-tested against the
actual `useOneSub` SDK API.

## Concurrency Model

- Node.js single-threaded — no mutex needed for InMemoryStore Map operations
- Google OAuth token: promise deduplication prevents thundering herd, 60s pre-expiry refresh window
- **Apple App Store Server API JWT**: same pattern — module-level cache keyed by `${issuerId}|${keyId}`, 20-minute TTL, refresh 60s before expiry, in-flight Promise dedup so concurrent burst pays one ECDSA-sign (`0.9.0+`)
- Apple JWS: each payload's `x5c` chain is verified through its intermediates to the pinned Apple
  Root CA G3 before the leaf key verifies the signature
- PostgresStore UPSERT: atomic `ON CONFLICT DO UPDATE` — no read-then-write race
- Outbound `fetchWithTimeout` (`http.ts`, `0.9.0+`): every upstream call wrapped with `AbortController` (default 10s). Caller signals composed via `addEventListener('abort', { once: true })`. Timer cleared in `finally` — no leaked handles

## Lifecycle State Machine

`SubscriptionInfo.status` is the canonical lifecycle state. The transitions are driven by:

1. **Notification mapping** (webhook handler) — primary signal. Apple `mapAppleNotificationStatus(notificationType, subtype)` and Google `isGoogle*Notification(notificationType)` family return the new status string deterministically per notification.
2. **Fresh re-fetch** (Google only) — after the notification map yields a status, `validateGoogleReceipt` is called against `subscriptionsv2.get` to refresh `expiresAt`/`willRenew`/`linkedPurchaseToken`/`autoResumeTime`. The notification-derived status is *preserved* for `grace_period`/`on_hold` (the v2 mapping can't always re-derive these without notification context); other statuses defer to the v2 response.
3. **Apple Status API fallback** — for an unknown `originalTransactionId`, `fetchAppleSubscriptionStatus` resolves canonical state from Apple, mapping `status` codes 1..5 → `active`/`expired`/`on_hold`/`grace_period`/`canceled`.

The status route's `active: boolean` collapses the lifecycle:
```
active = (status === 'active' || status === 'grace_period') && expiresAt > now
```

The `expiresAt > now` half is a backstop. Two cases need it:
- `refundPolicy: 'until_expiry'` keeps `status === 'active'` after a refund — `active` flips false naturally when expiry passes (no `EXPIRED` webhook required).
- General stale-record safety: if an `EXPIRED` webhook is missed, the user doesn't keep entitlement forever.

See `README.md` for the visual state diagram and host UX hints.

## Refund Policy

```ts
config.refundPolicy?: 'immediate' | 'until_expiry'   // default 'immediate'
```

Applies only to subscription refunds (Apple `REFUND`/`REVOKE`, Google `voidedPurchaseNotification` `productType=1`). Webhook handler decision tree:

```
isRefund?
  ├── IAP (type === 'Consumable' || 'Non-Consumable', or Google productType=2)
  │   → purchaseStore.deletePurchaseByTransactionId — always immediate (no expiry concept)
  │
  └── Subscription
      ├── refundPolicy === 'until_expiry'
      │   → store.save({ ...existing, willRenew: false })  // status + expiresAt preserved
      │
      └── refundPolicy === 'immediate' (default)
          → store.save({ ...existing, status: 'canceled', willRenew, expiresAt: fresh })
```

Apple `CONSUMPTION_REQUEST` is intentionally excluded from the refund branch — it's a refund *review* request, not a confirmed refund. Host can decide via `apple.consumptionInfoProvider`.

## Webhook Recovery (Apple Status API fallback)

When the Apple webhook receives a notification for an `originalTransactionId` the local store doesn't know:

1. If `apple.keyId` / `apple.issuerId` / `apple.privateKey` are configured: call `fetchAppleSubscriptionStatus(originalTransactionId, config.apple, { sandbox: env === 'Sandbox' })`.
2. The response contains `lastTransactions[]` with the canonical state. Pick the entry matching the requested `originalTransactionId`, decode `signedTransactionInfo` + `signedRenewalInfo`, map `status` 1..5 → lifecycle state.
3. Save the recovered record under a placeholder `userId = originalTransactionId`.
4. The first subsequent `POST /onesub/validate` from the host will overwrite that placeholder with the real `userId` (provider derives it from the request body).

Without API credentials the webhook still 200s (so Apple stops retrying) but logs the missed transaction. Recovery requires manual re-validate from the host.

## Hooks (host integration points)

Hooks let the host plug analytics / business logic into webhook lifecycle without forking onesub. All hooks are **fire-and-forget** — failures are caught + logged via `log.warn`, never propagated to the webhook response.

| Hook | When | Purpose |
|------|------|---------|
| `apple.consumptionInfoProvider(ctx)` | `CONSUMPTION_REQUEST` notification + apple credentials present | Return `AppleConsumptionRequest` body; webhook PUTs it to Apple's `/inApps/v1/transactions/consumption/{txId}`. Without it, Apple has no usage signal and tends to grant the refund. |
| `google.onPriceChangeConfirmed(ctx)` | `SUBSCRIPTION_PRICE_CHANGE_CONFIRMED` (8) RTDN | Notify analytics / send in-app notification; new price applies on next renewal. For the actual new price, host calls `subscriptionsv2.get` directly. |
