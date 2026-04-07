# onesub — AI Guide

## Overview

Server-side receipt validation middleware for react-native-iap. Monthly subscription + paywall. That's it.

## Monorepo Structure

```
onesub/
├── packages/shared/       # @onesub/shared — shared types & constants
├── packages/server/       # @onesub/server — Express middleware (receipt validation + webhooks)
├── packages/sdk/          # @onesub/sdk — React Native SDK (useOneSub + Paywall)
└── packages/mcp-server/   # @onesub/mcp-server — MCP tools (AI integration)
```

## Tech Stack

- **Language**: TypeScript 5.7, ESM (NodeNext)
- **Server**: Express.js middleware pattern
- **SDK**: React Native + react-native-iap
- **MCP**: @modelcontextprotocol/sdk (stdio transport)
- **Receipt Validation**: Apple StoreKit 2 JWS (JWKS verified) + Google Play Developer API v3

## Core Philosophy

1. **Simplicity**: One monthly subscription + one paywall. Nothing more.
2. **Open Source**: MIT license, self-hostable
3. **Pluggable**: Express middleware — one line: `app.use(createOneSubMiddleware(config))`
4. **AI-native**: MCP tools for product creation, paywall generation, troubleshooting

## Dev Commands

```bash
npm install              # install all dependencies
npm run build            # build all packages
npm run type-check       # TypeScript check
npm test                 # run vitest (39 tests)
```

## Package Roles

### @onesub/shared
Shared types and constants. Imported by all other packages.

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

### @onesub/mcp-server
7 MCP tools:
- `onesub_setup` — analyze project + generate integration code
- `onesub_add_paywall` — generate paywall component
- `onesub_check_status` — check subscription status
- `onesub_troubleshoot` — diagnose IAP issues
- `onesub_create_product` — create products on App Store Connect / Google Play
- `onesub_list_products` — list registered products
- `onesub_view_subscribers` — query subscriber status

## Coding Rules

- `.js` extension required in all ESM imports
- Shared types defined only in `@onesub/shared`
- Server store uses `SubscriptionStore` interface (default: in-memory, pluggable)
- SDK uses react-native-iap as optional peer dependency
- Status strings use `SUBSCRIPTION_STATUS` constants (no string literals)
- Apple/Google config types derived from `OneSubServerConfig` in shared (no local duplicates)
