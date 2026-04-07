# Architecture

## Package Dependency Graph

```
@onesub/shared (leaf — no dependencies on other onesub packages)
    ↑
    ├── @onesub/server (depends on shared)
    ├── onesub (SDK, depends on shared)
    └── @onesub/mcp-server (depends on shared)
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
      ├── GET  /onesub/status             → subscriptionStore.getByUserId → { active }
      ├── POST /onesub/webhook/apple      → JWS verify → decode → subscriptionStore.save
      ├── POST /onesub/webhook/google     → JWT verify → decode → subscriptionStore.save
      │
      │── One-time Purchases:
      ├── POST /onesub/purchase/validate  → zod → provider.validate → purchaseStore.save
      └── GET  /onesub/purchase/status    → purchaseStore.getPurchasesByUserId → { purchases }
```

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
}
```

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
- Google OAuth token: promise deduplication prevents thundering herd
- Apple JWKS: `jose.createRemoteJWKSet` handles caching/refresh internally
- PostgresStore UPSERT: atomic `ON CONFLICT DO UPDATE` — no read-then-write race
