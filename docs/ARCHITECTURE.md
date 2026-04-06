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
      ├── POST /onesub/validate    → zod validation → provider.validate → store.save
      ├── GET  /onesub/status      → store.getByUserId → { active, subscription }
      ├── POST /onesub/webhook/apple  → JWS verify → decode → store.save
      └── POST /onesub/webhook/google → JWT verify → decode → store.save
```

## Subscription Store Interface

```ts
interface SubscriptionStore {
  save(subscription: SubscriptionInfo): Promise<void>;
  getByUserId(userId: string): Promise<SubscriptionInfo | null>;
  getByTransactionId(txId: string): Promise<SubscriptionInfo | null>;
}
```

Implementations:
- `InMemorySubscriptionStore` — development/testing only
- `PostgresSubscriptionStore` — production (raw pg, UPSERT, auto-schema)

## MCP Tool Design

All 4 tools return `{ content: [{ type: 'text', text: string }] }`:
- `onesub_setup` — generates integration code matching actual SDK API (`useOneSub`)
- `onesub_add_paywall` — generates paywall component (3 styles)
- `onesub_check_status` — live API call to server
- `onesub_troubleshoot` — pattern-matching diagnostics

MCP output is regression-tested: tests assert generated code contains `useOneSub` (not `useSubscription`).

## Concurrency Model

- Node.js single-threaded — no mutex needed for InMemoryStore Map operations
- Google OAuth token: promise deduplication prevents thundering herd
- Apple JWKS: `jose.createRemoteJWKSet` handles caching/refresh internally
- PostgresStore UPSERT: atomic `ON CONFLICT DO UPDATE` — no read-then-write race
