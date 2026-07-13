# onesub — AI Guide

## Position

**onesub = 결제와 관련된 모든 것.**
IAP lifecycle (CRUD), receipt validation, webhook lifecycle, subscription status, revenue metrics.

Distinct from **mimi-seed** (store metadata, screenshots, launch readiness, Firebase/AdMob, analytics).
`@onesub/providers` is consumed by both — mimi-seed's SKU creation tools delegate here instead of
maintaining their own App Store Connect / Google Play wrappers.

## Monorepo Structure

```
onesub/
├── packages/shared/       # @onesub/shared — shared types & constants
├── packages/providers/    # @onesub/providers — App Store Connect + Google Play API wrappers (standalone, no deps)
├── packages/server/       # @onesub/server — Express middleware (receipt validation + webhooks)
├── packages/sdk/          # @onesub/sdk — React Native SDK (useOneSub + Paywall)
├── packages/unity/        # com.onesub.unity — free Unity runtime SDK
├── packages/unity-platform-services/ # optional PenguinRun sharing/review/social helpers
└── packages/mcp-server/   # @onesub/mcp-server — MCP tools (AI integration)
```

## Tech Stack

- **Language**: TypeScript 5.7, ESM (NodeNext)
- **Server**: Express.js middleware pattern
- **SDK**: React Native + react-native-iap
- **MCP**: @modelcontextprotocol/sdk (stdio transport)
- **Receipt Validation**: Apple StoreKit 2 JWS (JWKS verified) + Google Play Developer API v3
- **Providers**: Pure Node.js crypto + fetch — no external dependencies

## Core Philosophy

1. **Simplicity**: One monthly subscription + one paywall. Nothing more.
2. **Open Source**: MIT license, self-hostable
3. **Pluggable**: Express middleware — one line: `app.use(createOneSubMiddleware(config))`
4. **AI-native**: MCP tools for product creation, paywall generation, troubleshooting

## Product Boundary

- This repository is the public MIT-licensed OneSub Core source of truth.
- `packages/unity` remains the complete manual Unity purchasing and validation SDK.
- Commercial Unity Editor automation and MCP for Unity custom tools live in the separate private
  `onesub-unity-pro` repository. Never copy Pro sources into this repository.
- Public APIs shared with Pro must remain backward compatible within a minor release line. Document
  compatibility changes in `docs/UNITY-PRO.md`.

## Dev Commands

```bash
npm install              # install all dependencies
npm run build            # build all packages (shared → providers → server → sdk → mcp-server → cli)
npm run type-check       # TypeScript check (per-package: npm run type-check -w @onesub/providers)
npm test                 # run vitest (443 tests)
```

## Package Roles

### @onesub/shared
Shared types and constants. Imported by all other packages.

### @onesub/providers
Standalone App Store Connect + Google Play API wrappers. No external runtime deps.
Exports platform-prefixed functions for full IAP CRUD:
```ts
// Apple
createAppleSubscription, createAppleOneTimePurchase, updateAppleProduct, deleteAppleProduct, listAppleProducts, resolveAppleAppId, findApplePricePoint
// Google
createGoogleSubscription, createGoogleOneTimePurchase, updateGoogleProduct, deleteGoogleProduct, listGoogleProducts
// Shared
type RegionPrice  // { currency: string; price: number }
```
All functions accept `extraRegions?: RegionPrice[]` for multi-region pricing.
Price unit: smallest unit (cents for USD, whole units for KRW/JPY).

### @onesub/server
Express middleware. Two usage modes:
```ts
// 1. Mount on existing server
app.use(createOneSubMiddleware(config));

// 2. Standalone server
createOneSubServer(config).listen(4100);
```

### @onesub/sdk
React Native SDK:
```tsx
<OneSubProvider config={config} userId={userId}>
  <App />
</OneSubProvider>

// In any component
const { isActive, subscribe } = useOneSub();
```

### com.onesub.unity
Free Unity runtime SDK. Provides Unity IAP purchase, restore, localized pricing, server receipt
validation, and entitlement events. Project-specific adapters and UI wiring are manual in Core.
See `docs/UNITY-PRO.md` for the commercial automation boundary.

### com.onesub.unity.platform-services
Optional public package for PenguinRun sharing, review, leaderboard, and authentication helpers.
It must never be folded back into the purchasing Core package.

### @onesub/mcp-server
10 MCP tools:
- `onesub_setup` — analyze project + generate integration code
- `onesub_add_paywall` — generate paywall component
- `onesub_check_status` — check subscription status
- `onesub_troubleshoot` — diagnose IAP issues
- `onesub_create_product` — create subscription / consumable / non-consumable on App Store Connect + Google Play (supports extraRegions)
- `onesub_list_products` — list all IAP products (subscriptions + one-time)
- `onesub_manage_product` — update name or delete a product
- `onesub_view_subscribers` — query subscriber status
- `onesub_simulate_purchase` — simulate purchase against mock server
- `onesub_simulate_webhook` — send fake Apple/Google webhook to test lifecycle transitions
- `onesub_inspect_state` — read current subscription + purchase state for a user

## Coding Rules

- `.js` extension required in all ESM imports
- Shared types defined only in `@onesub/shared` (providers types in `@onesub/providers`)
- Server store uses `SubscriptionStore` interface (default: in-memory, pluggable)
- SDK uses react-native-iap as optional peer dependency
- Status strings use `SUBSCRIPTION_STATUS` constants (no string literals)
- Apple/Google config types derived from `OneSubServerConfig` in shared (no local duplicates)
- MCP tool files import provider functions from `@onesub/providers`, not from local providers/ folder
