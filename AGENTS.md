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
| `packages/cli` | `@onesub/cli`: `onesub init` scaffolder, server templates, and the `onesub dev` fully mocked server used for local and agent testing |
| `packages/dashboard` | Private npm workspace for the self-hosted Next.js operations dashboard; shipped as a Docker image |
| `packages/unity` | `com.onesub.unity`: public Unity 2022.3+ purchasing and server-validation Core package |
| `packages/unity-platform-services` | Optional Unity sharing, review, leaderboard, and authentication helpers; not part of purchasing Core |
| `examples` | Runnable server and Expo examples. Not npm workspaces, but inside this checkout they still resolve `@onesub/server` through the root `node_modules` symlink to `packages/server` — so they do exercise your local build. The version pin in their own `package.json` only applies to a standalone copy |
| `bench` | k6 status/webhook load tests, run by the scheduled `bench` workflow |
| `scripts` | `validate-docs.mjs`, which backs `npm run docs:check` |
| `docs` | Architecture, security, deployment, migration, receipt-error, and Unity boundary documentation |

The two Unity packages are UPM packages, not npm workspaces. `validate-unity-packages.ps1` lives at
the repository root, not under `scripts`.

## Commands

Run commands from the repository root unless a package README says otherwise.

```bash
npm ci                 # reproducible install. Never run bare `npm install` unless you are
                       # deliberately changing dependencies — it rewrites package-lock.json
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
npm run size -w @onesub/server        # requires a prior build of @onesub/server
pwsh ./validate-unity-packages.ps1
```

A per-workspace `type-check` script exists only in `providers`, `sdk`, `mcp-server`, and `dashboard`.
For `shared`, `server`, and `cli`, type-check with `npx tsc --noEmit -p packages/<name>` — the root
`type-check` script reaches them that way. `npm run type-check -w @onesub/server` fails with
`Missing script`.

## Build Model and Traps

Read this before your first edit. These traps fire on ordinary tasks and two of them fail silently.

**`@onesub/shared` is consumed as compiled output, not as source.** Dependents resolve
`@onesub/shared` to `packages/shared/dist`, which is gitignored, is not rebuilt automatically, and
has no Vitest alias or tsconfig path mapping. After any edit under `packages/shared/src` you must run
`npm run build -w @onesub/shared` before `npm test`, `npm run type-check`, or any dependent build
observes it.

The stale `dist` is stale in its `.d.ts` too, so `tsc` usually catches it loudly. The dangerous case
is **`npm test`**: Vitest transpiles without type-checking, so a new value export that is missing
from the stale `dist` is simply `undefined` at runtime — a comparison quietly never matches and no
error is thrown. A green `npm test` on a shared change you did not rebuild proves nothing. To recover
from a confusing state, delete `packages/*/dist` and re-run `npm run build`.

**Two tests enforce contract parity mechanically, and both are easy to trip.**

- `packages/server/src/__tests__/openapi.test.ts` mounts every router and asserts both directions:
  every mounted route is documented in `packages/server/src/openapi.ts`, and every documented path is
  actually mounted. Adding, renaming, or removing a route without editing `openapi.ts` turns CI red.
- `packages/server/src/__tests__/schema.test.ts` asserts that `packages/server/sql/schema.sql`
  matches the DDL string constants in `packages/server/src/stores/schema.ts`. Persisted-column
  changes must edit both.

When either test fails, the message is "you changed one side of a contract," not "you broke
behavior."

**Line endings.** `.gitattributes` forces LF on text sources; the schema parity test additionally
strips `\r` itself, so it is CRLF-proof today. Keep both defenses: add any new text file type to
`.gitattributes`, and do not assume a parser downstream is as forgiving.

**This repository is developed on Windows.** Command blocks in `docs/` are written for bash. In
PowerShell, translate them: `rm -rf` is not available, `\` line continuations must become backticks,
POSIX inline env prefixes (`FOO=bar npm run dev`) must become `$env:FOO = 'bar'; npm run dev`, and
`curl -d '{...}'` needs `Invoke-RestMethod` or `curl.exe`. The root `clean` script
(`rm -rf packages/*/dist`) is POSIX-only; delete the `dist` folders directly instead.

**`npm run size -w @onesub/server` measures `dist/`, so it needs a build first.** It gates the
gzipped ESM and CJS bundles against the ceilings in `packages/server/.size-limit.cjs` and is a
required CI check. If a deliberate surface addition exceeds a ceiling, raise the limit in that file
and add a dated comment recording the reason and the measured size, following the existing entry.
Do not delete the check or a budget entry to make it pass.

**Never run these locally.** `npm run version-packages` and `npm run release` are owned by the
`Release` workflow. `version-packages` runs `changeset version`, which rewrites every package version
field, rewrites every per-package `CHANGELOG.md`, and consumes `.changeset/*.md` — exactly the
hand-editing this guide forbids, performed by machine. Author changesets with `npm run changeset`
and let CI apply them.

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
- The React Native SDK has exactly one purchase adapter: `react-native-iap`, `require`d at module
  scope inside a `try/catch` in `packages/sdk/src/OneSubProvider.tsx`. When it is absent the provider
  still imports and renders, and the purchase paths throw a clear error instead.
  `expo-in-app-purchases` is listed alongside it in `peerDependenciesMeta` as optional, but has **no
  adapter behind it** — do not treat it as a code path to preserve, and do not "restore" it without
  an explicit product decision. Keep the structured `OneSubError` behavior working.
- Keep purchasing-only code in `packages/unity`. Sharing, review, social, leaderboard, and auth
  helpers belong in `packages/unity-platform-services`. Run the UPM boundary validator after Unity
  package changes.

## Contract Change Checklist

Some changes must move several files together or a parity test fails. Use these as the minimum file
set, then let the tests confirm.

**Adding or changing a route:** `packages/shared/src/constants.ts` (`ROUTES`) → the router under
`packages/server/src/routes/` → `packages/server/src/openapi.ts` (parity-tested) →
`packages/server/README.md` (the canonical route list, `docs:check`-enforced against the spec) →
`docs/ARCHITECTURE.md` if the middleware flow changes. Both links in that chain are machine-checked,
so a route cannot ship undocumented — but only `packages/server/README.md` is checked. Route tables in
`README.md` and `SKILL.md` are prose and still drift by hand.

**Adding a persisted field to `SubscriptionInfo` or `PurchaseInfo`:** `packages/shared/src/types.ts`
→ `packages/server/src/stores/schema.ts` (embedded DDL plus the additive `ALTER TABLE` backfill) →
`packages/server/sql/schema.sql` (parity-tested) → `packages/server/src/stores/postgres.ts` →
`packages/server/src/stores/redis.ts` → `packages/server/src/store.ts` (in-memory) → the reading
route → `packages/server/src/openapi.ts` → `packages/dashboard` and `packages/sdk` if surfaced.
Rebuild `@onesub/shared` first, or everything downstream reads the old type.

**Adding a config field:** `packages/shared/src/types.ts` → the consuming code →
`docs/CONFIGURATION.md` (the canonical config reference) → `packages/server/README.md` if it is part
of the middleware's public surface.

**Adding an error code:** `packages/shared/src/constants.ts` (`ONESUB_ERROR_CODE`) →
`docs/RECEIPT-ERRORS.md`, which is the canonical cause-and-fix catalog.

**Adding an MCP tool or CLI command:** register it, then document it in
`packages/mcp-server/README.md` or `packages/cli/README.md`. `npm run docs:check` fails if a
registered tool or command is undocumented.

**Adding a workspace:** root `package.json` `workspaces` and `build`/`type-check` scripts → CI
coverage → the Repository Map above (`docs:check` enforces this) → the package catalog in
`README.md`.

**Releasing a Unity package:** Changesets does not cover UPM. Bump the version in
`packages/unity*/package.json` → tag as `<upm-package-name>@<version>` (for example
`com.onesub.unity@0.2.0`) → update the version column in the `README.md` package catalog and the
pinned install URLs in `docs/UNITY-INTEGRATION.md`. Nothing verifies these three agree, so check them
by hand.

## Testing Model

There is no `fixtures/` directory. Deterministic provider behavior comes from two places:

- `packages/server/src/providers/mock.ts` — the mock provider, selected by `apple.mockMode` /
  `google.mockMode` in config and keyed on receipt prefixes. This is what unit tests drive, and it is
  the same provider behind `onesub dev`.
- `packages/server/src/__tests__/test-utils.ts` — shared test setup.

Run a single test file with `npm test -- <path>`. Inside this repository, always exercise the CLI
built from the current checkout (`node packages/cli/dist/index.js dev --port 4100`); `npx @onesub/cli`
resolves to the *published* package, so a change under test appears to have no effect. See
`docs/TESTING.md`.

## What CI Gates On

Reconstructing this from the workflows is slow, so it is stated once here. `.github/workflows/ci.yml`:

1. `npm ci`
2. `npm run build`  (this is the real type-error gate; CI never runs root `npm run type-check`)
3. `npm test`
4. `pwsh ./validate-unity-packages.ps1`
5. `npm run size -w @onesub/server`

Plus a **separate `dashboard` job** — `npm run build -w @onesub/shared` → `type-check` → `build` for
`@onesub/dashboard`. CI can therefore be red for a dashboard break while the entire root build is
green. Plus `codeql.yml` (`security-extended`, can fail a PR) and a path-filtered `docs.yml` running
`npm run docs:check`.

`ci.yml` sets `paths-ignore: '**/*.md'`, so a Markdown-only PR runs **no build and no tests** — its
gates are `docs.yml` and CodeQL, which has no path filter and runs on every PR.

`docs.yml` is path-filtered to Markdown plus `package.json`, `scripts/validate-docs.mjs`,
`packages/cli/src/index.ts`, and `packages/mcp-server/src/index.ts`. It does **not** fire on other
source changes, so renaming a file that documentation references can ship green. Run
`npm run docs:check` yourself when you rename or move anything the docs cite.

## Change Workflow

1. Read the nearest package README and the relevant source/tests before editing.
2. Check `git status` and preserve unrelated user changes.
3. Make the smallest coherent change and add/update tests for behavior changes.
4. If the change touches a contract, follow the Contract Change Checklist above.
5. Update the owning document — see Documentation Ownership — when routes, config, exports, error
   codes, package boundaries, or operator workflows change.
6. Run the checks for what you touched:

   | Touched | Run |
   |---|---|
   | `packages/shared/src` | `npm run build -w @onesub/shared`, then `npm test` and `npm run type-check` |
   | `packages/server/src` | `npm run build -w @onesub/server`, `npm test`, `npm run size -w @onesub/server` |
   | A route or the OpenAPI spec | the above plus `npm test -- packages/server/src/__tests__/openapi.test.ts` |
   | A store or SQL schema | the above plus `npm test -- packages/server/src/__tests__/schema.test.ts` |
   | `packages/dashboard` | the three dashboard commands under Commands |
   | `packages/unity*` | `pwsh ./validate-unity-packages.ps1` |
   | Any `.md` | `npm run docs:check` |
   | Anything cross-package | the full CI gate set above |

   Report any check you could not run, and why.
7. For a published-package change, run `npm run changeset` and commit the generated `.changeset/*.md`.
   Do not hand-edit package versions or generated per-package changelogs.
8. Breaking changes also require `docs/MIGRATION.md`. Docs, tests, CI, `examples/*`, and
   `packages/dashboard` changes need no changeset — the dashboard is private and ships as a Docker
   image published by `docker-dashboard.yml`, which also republishes on any `packages/shared/src`
   change.

## Documentation Ownership

Each fact has one owner. Link to the owner rather than restating it.

| Document | Owns |
|---|---|
| `README.md` | Product overview, quick start, supported features, package catalog, roadmap |
| `docs/README.md` | Documentation index and routing |
| `docs/ARCHITECTURE.md` | Dependency direction, runtime flow, stores, state transitions, hooks |
| `docs/AI-WORKFLOW.md` | Copy-ready prompts for repository work, app integration, safe MCP use |
| `docs/LOCAL-DEVELOPMENT.md` | Clean-clone setup and local services |
| `docs/CONFIGURATION.md` | Every `OneSubServerConfig` field, SDK, multi-app, and environment config |
| `docs/DEPLOYMENT.md` | Production topology, durable infrastructure, operations, recovery |
| `docs/TESTING.md` | Test suites, mock receipts, E2E, dashboard, docs, Unity checks, CI parity |
| `docs/POSTGRES.md` | Postgres schema, indexing, initialization, read replicas |
| `docs/SECURITY.md` | Trust boundaries, credential handling, verification, vulnerability reporting |
| `docs/RECEIPT-ERRORS.md` | Every `ONESUB_ERROR_CODE` with cause and fix |
| `docs/MIGRATION.md` | Version-specific upgrade notes and breaking changes |
| `docs/MIGRATE-FROM-REVENUECAT.md` | Moving an app and its data off RevenueCat |
| `docs/UNITY-INTEGRATION.md` | Unity Core installation, runtime flow, events, host responsibilities |
| `docs/UNITY-PRO.md` | The Core/Pro boundary |
| `packages/server/README.md` | The canonical route list (`docs:check`-enforced) and middleware API |
| `packages/shared/README.md` | Lifecycle states and the `active` formula |
| `packages/mcp-server/README.md` | The MCP tool catalog (`docs:check`-enforced) |
| `packages/cli/README.md` | The CLI command list (`docs:check`-enforced) |
| Other package `README.md` | That package's installation and API |
| `CONTRIBUTING.md` | Contributor onboarding, releases, PR checklist |
| `SKILL.md` | Public single-file integration context for agents adding OneSub to *another* app; not the internal contributor guide |
| `AGENTS.md` | Internal repository instructions shared by Codex and Claude |
| `CLAUDE.md` | A thin Claude entry point only; do not duplicate this guide there |

Avoid volatile claims: hard-coded test counts, tool counts, package counts, or version numbers.
Derive command order, tool names, route names, and package names from the current code.
`scripts/validate-docs.mjs` mechanizes part of this. It checks local links and referenced file paths,
that every npm workspace appears in the Repository Map, that every registered MCP tool and CLI command
is documented, and that the route list in `packages/server/README.md` matches the OpenAPI spec — which
`openapi.test.ts` in turn holds to the actually mounted routers. It cannot catch a wrong version
number or a stale prose claim. Verify those against the source.

When adding a check there, also add its inputs to the `paths` filter in `.github/workflows/docs.yml`,
or the check will not run on the change that breaks it. Keep the script dependency-free: that workflow
has no `npm ci` step.
