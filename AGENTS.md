# OneSub Repository Guide

This is the canonical repository guide for coding agents. `CLAUDE.md` imports this file so Codex
and Claude share one set of project instructions. Keep durable project knowledge here; keep public
setup and API documentation in `README.md` and `docs/`.

## Project Scope

OneSub is a self-hosted in-app purchase backend and client toolkit. It validates Apple StoreKit 2
and Google Play receipts, processes subscription webhooks, stores subscription and one-time purchase
state, exposes entitlement/admin/metrics APIs, and provides React Native and Unity clients.

This public repository is the MIT-licensed Core source of truth. Commercial Unity Editor automation
and MCP for Unity custom tools live in the separate private `onesub-unity-pro` repository. Do not
copy Pro sources into this repository. See `docs/UNITY-PRO.md` for the compatibility boundary.

## Repository Map

| Path | Role |
|---|---|
| `packages/shared` | `@onesub/shared`: canonical cross-package types, status values, error codes, and route constants |
| `packages/providers` | `@onesub/providers`: dependency-free App Store Connect and Google Play product-management wrappers |
| `packages/server` | `@onesub/server`: Express middleware/server, receipt validation, webhooks, stores, admin APIs, metrics, OpenAPI, and tracing |
| `packages/sdk` | `@jeonghwanko/onesub-sdk`: React Native provider, hook, paywall components, and HTTP client |
| `packages/mcp-server` | `@onesub/mcp-server`: stdio MCP tools for setup, product management, diagnostics, and simulation |
| `packages/cli` | `@onesub/cli`: `onesub init` scaffolder and server templates |
| `packages/dashboard` | Private npm workspace for the self-hosted Next.js operations dashboard; shipped as a Docker image |
| `packages/unity` | `com.onesub.unity`: public Unity 2022.3+ purchasing and server-validation Core package |
| `packages/unity-platform-services` | Optional Unity sharing, review, leaderboard, and authentication helpers; not part of purchasing Core |
| `examples` | Runnable server and Expo examples |
| `docs` | Architecture, security, deployment, migration, receipt-error, and Unity boundary documentation |

The two Unity packages are UPM packages, not npm workspaces.

## Commands

Run commands from the repository root unless a package README says otherwise.

```bash
npm ci                 # reproducible install; use npm install only when changing dependencies
npm run build          # shared -> providers -> server -> sdk -> mcp-server -> cli
npm run type-check     # all TypeScript workspaces, including dashboard
npm test               # complete Vitest suite
```

The root build intentionally excludes the Next.js dashboard. When dashboard or shared contracts
change, also run:

```bash
npm run build -w @onesub/shared
npm run type-check -w @onesub/dashboard
npm run build -w @onesub/dashboard
```

Useful focused checks:

```bash
npm test -- packages/server/src/__tests__/apps.test.ts
npm run docs:check
npm run build -w @onesub/server
npm run type-check -w @onesub/mcp-server
pwsh ./validate-unity-packages.ps1
npm run size -w @onesub/server
```

Use the closest relevant checks while iterating, then run the broader checks appropriate to the
changed surface. Markdown-only changes do not require a package release or the full build.

## Architecture Rules

- Use ESM throughout TypeScript packages. Relative imports in `.ts` source must include the emitted
  `.js` extension.
- Put cross-package contracts in `@onesub/shared`; do not duplicate config, status, purchase, route,
  or error-code types in consumers.
- Use `ROUTES`, `SUBSCRIPTION_STATUS`, `PURCHASE_TYPE`, and `ONESUB_ERROR_CODE` instead of repeating
  their string values.
- Keep the server behind `SubscriptionStore` and `PurchaseStore`. When an interface changes, update
  the in-memory, PostgreSQL, and Redis implementations and their tests together.
- Preserve single-app compatibility. Multi-app requests resolve through `packages/server/src/apps.ts`;
  an unknown `appId` must never fall back to another app's credentials.
- Route all server logging through the configured logger and outbound provider calls through the
  hardened HTTP/cache helpers. Do not add direct `console.*` or unbounded provider `fetch` calls.
- Keep `apple.mockMode`, `google.mockMode`, and `skipJwsVerification` development-only. Never weaken
  JWS/certificate verification, webhook authentication, ownership checks, body limits, or secret
  comparison behavior.
- One-time-purchase refunds delete by transaction ID. Do not replace that with a user/product-wide
  deletion, which can revoke valid sibling consumable purchases.
- MCP product tools import App Store Connect/Google Play operations from `@onesub/providers`; do not
  recreate provider clients inside `packages/mcp-server`.
- The React Native SDK treats `react-native-iap` and `expo-in-app-purchases` as optional peers. Keep
  both adapter paths and structured `OneSubError` behavior working.
- Keep purchasing-only code in `packages/unity`. Sharing, review, social, leaderboard, and auth
  helpers belong in `packages/unity-platform-services`. Run the UPM boundary validator after Unity
  package changes.

## Change Workflow

1. Read the nearest package README and the relevant source/tests before editing.
2. Check `git status` and preserve unrelated user changes.
3. Make the smallest coherent change and add/update tests for behavior changes.
4. Update public docs when routes, config, exports, package boundaries, or operator workflows change.
5. Run checks proportional to the affected packages and report any check that could not be run.
6. For a published-package change, run `npm run changeset` and commit the generated
   `.changeset/*.md`. Do not hand-edit package versions or generated per-package changelogs.
7. Breaking changes also require `docs/MIGRATION.md`. Docs/tests/CI/example-only changes do not need
   a changeset.

## Documentation Ownership

- `README.md`: product overview, quick start, supported features, package catalog, and roadmap.
- `docs/README.md`: documentation index and routing guide.
- `docs/ARCHITECTURE.md`: dependency direction, runtime flow, stores, state transitions, and hooks.
- `docs/AI-WORKFLOW.md`: copy-ready prompts for repository work, app integration, and safe MCP use.
- `docs/LOCAL-DEVELOPMENT.md`: clean-clone setup, local services, and contributor baseline checks.
- `docs/CONFIGURATION.md`: server, middleware, SDK, multi-app, and environment configuration.
- `docs/DEPLOYMENT.md`: production topology, durable infrastructure, operations, and recovery.
- `docs/TESTING.md`: deterministic, mock, E2E, dashboard, documentation, and Unity checks.
- `docs/UNITY-INTEGRATION.md`: public Unity Core installation, runtime flow, events, and host responsibilities.
- `CONTRIBUTING.md`: contributor setup, tests, releases, and PR checklist.
- Package `README.md` files: package-specific installation and APIs.
- `SKILL.md`: public single-file integration context for agents integrating OneSub into another app;
  it is not the internal contributor guide.
- `AGENTS.md`: internal repository instructions shared by Codex and Claude.
- `CLAUDE.md`: a thin Claude entry point only; do not duplicate this guide there.

Avoid volatile claims such as a hard-coded test count. Derive command order, tool counts, route names,
and package names from the current code before documenting them.
