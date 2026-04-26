# Architecture

## Package Dependency Graph

```
@onesub/shared (leaf — no dependencies on other onesub packages)
    ↑
    ├── @onesub/server (depends on shared)
    ├── @jeonghwanko/onesub-sdk (depends on shared)
    ├── @onesub/mcp-server (depends on shared)
    └── @onesub/cli (depends on shared; generates server-project templates)
```

No circular dependencies. SDK and server are independent of each other.

## SSOT Rules

| Concept | Single Source | Consumers |
|---------|-------------|-----------|
| Route paths | `shared/constants.ts` → `ROUTES` | server routes, SDK api.ts, MCP check-status |
| Subscription status | `shared/constants.ts` → `SUBSCRIPTION_STATUS` | server providers, webhook handlers, status route |
| Status type | `shared/types.ts` → `SubscriptionStatus` | all packages |
| Apple/Google config | `shared/types.ts` → `OneSubServerConfig` | server providers use `NonNullable<Config['apple']>` |
| Default port | `shared/constants.ts` → `DEFAULT_PORT` | server, MCP tools |
| SDK hook API | `sdk/useOneSub.ts` → `useOneSub()` | MCP code generation must match |

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
      ├── GET  /onesub/purchase/status    → purchaseStore.getPurchasesByUserId → { purchases }
      │
      └── Admin (only if config.adminSecret is set; requires X-Admin-Secret header):
          ├── DELETE /onesub/purchase/admin/:userId/:productId   → purchaseStore.deletePurchases
          ├── POST   /onesub/purchase/admin/grant                → purchaseStore.savePurchase
          └── POST   /onesub/purchase/admin/transfer             → purchaseStore.reassignPurchase
```

All runtime logging goes through `config.logger` (OneSubLogger interface; defaults to `console`). Providers and routes import `log` from the internal `logger.ts` singleton instead of calling `console.*` directly.

All outbound HTTP calls (Apple Status API, Apple Consumption Response, Google subscriptionsv2, Google OAuth, Google ack/consume) go through `http.ts/fetchWithTimeout` — `AbortController` with a 10s default budget so a hung upstream can't pile up webhook handlers.

## Store Interfaces

### SubscriptionStore (auto-renewable subscriptions)

```ts
interface SubscriptionStore {
  save(subscription: SubscriptionInfo): Promise<void>;
  getByUserId(userId: string): Promise<SubscriptionInfo | null>;
  getByTransactionId(txId: string): Promise<SubscriptionInfo | null>;
}
```

### PurchaseStore (consumable + non-consumable)

```ts
interface PurchaseStore {
  savePurchase(purchase: PurchaseInfo): Promise<void>;
  getPurchasesByUserId(userId: string): Promise<PurchaseInfo[]>;
  getPurchaseByTransactionId(txId: string): Promise<PurchaseInfo | null>;
  hasPurchased(userId: string, productId: string): Promise<boolean>;
  reassignPurchase(transactionId: string, newUserId: string): Promise<boolean>;       // 0.6.1+
  deletePurchases(userId: string, productId: string): Promise<number>;                // 0.4.0+
  deletePurchaseByTransactionId(transactionId: string): Promise<boolean>;             // 0.8.0+
}
```

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
- `PostgresSubscriptionStore` / `PostgresPurchaseStore` — production (raw pg, UPSERT, auto-schema)

### Non-consumable Duplicate Prevention

PostgreSQL enforces a partial unique index:
```sql
CREATE UNIQUE INDEX idx_onesub_purchases_non_consumable
  ON onesub_purchases (user_id, product_id)
  WHERE type = 'non_consumable';
```
Application-level `hasPurchased()` check is a fast path; the DB constraint is the atomic guarantee.

## MCP Tool Design

All 7 tools return `{ content: [{ type: 'text', text: string }] }`:
- `onesub_setup` — generates integration code matching actual SDK API (`useOneSub`)
- `onesub_add_paywall` — generates paywall component (3 styles)
- `onesub_check_status` — live API call to server
- `onesub_troubleshoot` — pattern-matching diagnostics
- `onesub_create_product` — create products on App Store Connect / Google Play via API
- `onesub_list_products` — list registered products from stores
- `onesub_view_subscribers` — query subscriber status

MCP output is regression-tested: tests assert generated code contains `useOneSub` (not `useSubscription`).

## Concurrency Model

- Node.js single-threaded — no mutex needed for InMemoryStore Map operations
- Google OAuth token: promise deduplication prevents thundering herd, 60s pre-expiry refresh window
- **Apple App Store Server API JWT**: same pattern — module-level cache keyed by `${issuerId}|${keyId}`, 20-minute TTL, refresh 60s before expiry, in-flight Promise dedup so concurrent burst pays one ECDSA-sign (`0.9.0+`)
- Apple JWKS: `jose.createRemoteJWKSet` handles caching/refresh internally
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
