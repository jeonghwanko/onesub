# OneSub Repository Guide

This is the canonical repository guide for coding agents. `CLAUDE.md` imports this file so Codex
and Claude share one set of project instructions. Keep durable project knowledge here; keep public
setup and API documentation in `README.md` and `docs/`.

**How to use this guide.** Read *Build Model and Traps* before your first edit — it is the section
that prevents silent failures. Then jump: *Source Map* for where code lives, *Start Here by Task* for
which files a given task touches, *Contract Change Checklist* for changes that must move several
files at once, *Change Workflow* and *Before You Call a Task Done* for what to run and report.
`docs/AI-WORKFLOW.md` holds copy-ready prompts; this file holds the rules.

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

## Source Map

File-level orientation, so you can open the right file instead of grepping for it. Paths are stable;
verify contents against the source before quoting them.

| Area | Files |
|---|---|
| Route constants, statuses, error codes | `packages/shared/src/constants.ts` |
| Cross-package types (config, `SubscriptionInfo`, `PurchaseInfo`) | `packages/shared/src/types.ts` |
| Middleware assembly and public exports | `packages/server/src/index.ts` |
| Routes | `packages/server/src/routes/` — `validate.ts`, `status.ts`, `purchase.ts`, `admin.ts`, `entitlements.ts`, `metrics.ts`, `apple-offer.ts`, `webhook-apple.ts`, `webhook-google.ts`, `webhook.ts` |
| Admin-secret comparison | `packages/server/src/routes/secret-compare.ts` |
| Sandbox-only entitlement overrides (process-local, never persisted) | `packages/server/src/test-overrides.ts` |
| Providers (Apple, Google, mock) | `packages/server/src/providers/` |
| Stores | `packages/server/src/store.ts` (in-memory), `packages/server/src/stores/postgres.ts`, `stores/redis.ts`, `stores/schema.ts` (DDL constants) |
| SQL schema shipped to users | `packages/server/sql/schema.sql` (parity-tested against `stores/schema.ts`) |
| OpenAPI spec | `packages/server/src/openapi.ts` (parity-tested against mounted routers) |
| Webhook durability | `packages/server/src/webhook-queue.ts`, `webhook-events.ts` |
| Outbound HTTP, caching, logging, tracing | `packages/server/src/http.ts`, `cache.ts`, `logger.ts`, `tracing.ts` |
| Multi-app credential resolution | `packages/server/src/apps.ts` |
| SDK provider (listeners, drain gate, purchase/restore entry points) | `packages/sdk/src/OneSubProvider.tsx` |
| SDK pure purchase-flow logic (in-flight map, native error mapping, type resolution) | `packages/sdk/src/purchaseFlow.ts` |
| SDK request shaping (Google offer tokens, platform args) | `packages/sdk/src/iapRequest.ts` |
| SDK error class and server HTTP client | `packages/sdk/src/OneSubError.ts`, `packages/sdk/src/api.ts` |
| MCP tool registration | `packages/mcp-server/src/index.ts`, tools under `packages/mcp-server/src/tools/` |
| CLI (`init` scaffolder + `dev` mock server) | `packages/cli/src/index.ts`, templates under `packages/cli/templates/` |
| Docs validator | `scripts/validate-docs.mjs` |

`packages/sdk/src/purchaseFlow.ts` holds the logic that is unit-testable without a native module;
`OneSubProvider.tsx` holds the React and `react-native-iap` wiring. Put new purchase logic in
`purchaseFlow.ts` and test it directly — that is why the split exists.

## Start Here by Task

Routing table for the tasks that come up most. Each row is "open these first," not the full file set;
contract changes still follow the Contract Change Checklist.

| Task | Open first | Then run |
|---|---|---|
| Change or add a route | `packages/shared/src/constants.ts`, the router, `packages/server/src/openapi.ts` | `npm test -- packages/server/src/__tests__/openapi.test.ts`, `npm run docs:check` |
| Change receipt validation | `packages/server/src/routes/validate.ts`, `packages/server/src/providers/` | `npm test -- packages/server/src/__tests__` |
| Change webhook handling | `packages/server/src/routes/webhook-*.ts`, `webhook-queue.ts` | `npm test -- packages/server/src/__tests__` |
| Add or change a persisted field | `packages/shared/src/types.ts`, `stores/schema.ts`, `sql/schema.sql` | rebuild `@onesub/shared`, then `npm test -- packages/server/src/__tests__/schema.test.ts` |
| Change SDK purchase behavior | `packages/sdk/src/purchaseFlow.ts`, `packages/sdk/src/OneSubProvider.tsx` | `npm test -- packages/sdk/src/__tests__`, `npm run type-check -w @jeonghwanko/onesub-sdk` |
| Add an error code | `packages/shared/src/constants.ts`, `docs/RECEIPT-ERRORS.md` | rebuild `@onesub/shared`, then `npm test` |
| Add an MCP tool | `packages/mcp-server/src/index.ts`, `packages/mcp-server/src/tools/` | `npm run docs:check`, `npm test` |
| Add a CLI command or template change | `packages/cli/src/index.ts`, `packages/cli/templates/` | `npm run docs:check`, `npm run build -w @onesub/cli` |
| Reproduce a client bug end to end | `packages/cli/src/index.ts` (`dev` command), `docs/TESTING.md` | `npm run build && node packages/cli/dist/index.js dev --port 4100` |
| Documentation only | the owning document in Documentation Ownership | `npm run docs:check` |

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

**This repository is developed on Windows, but agents often run it on Linux or macOS.** Everything
except `validate-unity-packages.ps1` (which needs `pwsh`) is cross-platform; the traps run the other
way. Command blocks in this guide and in `docs/` are written for bash. In
PowerShell, translate them: `rm -rf` is not available, `\` line continuations must become backticks,
POSIX inline env prefixes (`FOO=bar npm run dev`) must become `$env:FOO = 'bar'; npm run dev`, and
`curl -d '{...}'` needs `Invoke-RestMethod` or `curl.exe`. The root `clean` script
(`rm -rf packages/*/dist`) is POSIX-only; delete the `dist` folders directly instead. On a
POSIX host the reverse applies: `pwsh ./validate-unity-packages.ps1` only runs if PowerShell is
installed — if it is not, say so in your report rather than skipping the check silently.

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
- The SDK's `null` return and its thrown `OneSubError` mean different things, and the difference is
  load-bearing for host apps. `null` means "no purchase happened and that is normal" — user
  cancelled, or `restoreProduct` found nothing in the store's purchase history. A thrown
  `OneSubError` means the operation failed or was refused, including
  `CONCURRENT_PURCHASE` when `purchaseProduct` / `restoreProduct` is called while another IAP
  operation is in flight. Do not "simplify" a throw into a `null` (it makes a refusal look like a
  cancel) or a `null` into a throw. When a native `react-native-iap` error reaches the SDK, map it
  through `mapNativePurchaseErrorCode` in `packages/sdk/src/purchaseFlow.ts` instead of inventing a
  new code at the call site, and keep server-supplied `errorCode` values intact when rethrowing a
  failed validation.
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
3. `npm test`, with `DATABASE_URL` pointing at a `postgres:17-alpine` service container
4. `pwsh ./validate-unity-packages.ps1`
5. `npm run size -w @onesub/server`

**The Postgres store tests only run in CI unless you give them a database.**
`packages/server/src/__tests__/postgres-store.test.ts` skips itself when
`DATABASE_URL` is unset, so a green local `npm test` says nothing about the SQL. To
run them, point `DATABASE_URL` at a throwaway database — the tests `TRUNCATE` both
onesub tables between cases, so do not aim it at anything you care about:

```bash
docker run -d --rm -p 5432:5432 -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=onesub_test postgres:17-alpine
DATABASE_URL=postgres://postgres:postgres@localhost:5432/onesub_test npm test -- packages/server/src/__tests__/postgres-store.test.ts
```

**No Docker in this checkout?** Common in sandboxes: the daemon runs but your user is
not in the `docker` group and `sudo` wants a password. PostgreSQL needs no root — it
refuses to run as root — so a relocatable build unpacked outside the repo works
instead. `docs/TESTING.md` → *Postgres store tests* has the commands. Do not add the
Postgres binaries to this repo's dependencies to get them.

That file is the only thing that executes the Postgres SQL; `schema.test.ts`
compares the embedded DDL to `sql/schema.sql` as text and proves nothing about
whether either works. Any change under `packages/server/src/stores/postgres.ts`
wants a run against a real database before it is trusted.

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

The remaining workflows never gate a PR, so do not wait on them or try to trigger them:

| Workflow | Trigger | What it does |
|---|---|---|
| `publish.yml` (`Release`) | push to `master` | Runs Changesets: opens/updates the "Version Packages" PR, publishes on merge |
| `docker-dashboard.yml` | push to `master` touching `packages/dashboard/**`, `packages/shared/**`, the root `package.json` / `package-lock.json`, or `tsconfig.base.json` (also manual) | Builds and publishes the dashboard Docker image |
| `e2e.yml` | manual dispatch only | Real Apple/Google sandbox round-trips; needs shared secrets, so it cannot run on a PR |
| `bench.yml` | weekly schedule (also manual) | k6 status/webhook load tests from `bench/` |

If a change needs real sandbox coverage, say so in the PR description and ask a maintainer to dispatch
`e2e.yml` — you cannot validate that path locally.

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
   | `stores/postgres.ts` or `sql/schema.sql` | the above plus `postgres-store.test.ts` **with a real `DATABASE_URL`** — it skips silently without one |
   | `packages/dashboard` | the three dashboard commands under Commands |
   | `packages/unity*` | `pwsh ./validate-unity-packages.ps1` |
   | Any `.md` | `npm run docs:check` |
   | Anything cross-package | the full CI gate set above |

   Report any check you could not run, and why.
7. For a published-package change, run `npm run changeset` and commit the generated `.changeset/*.md`.
   Do not hand-edit package versions or generated per-package changelogs.
8. Breaking changes also require `docs/MIGRATION.md`. Docs, tests, CI, `examples/*`, and
   `packages/dashboard` changes need no changeset — the dashboard is private and ships as a Docker
   image published by `docker-dashboard.yml`, which also republishes on any `packages/shared`,
   root-manifest, or `tsconfig.base.json` change. The image builds with `npm ci` against the root
   lockfile, so a dependency bump touching nothing under `packages/` still changes what ships; keep
   that workflow's `paths` filter in sync with what `packages/dashboard/Dockerfile` copies.

### Before You Call a Task Done

Answer these five questions in your final report. They map one-to-one to how this repository fails.

1. **Rebuild:** did I touch `packages/shared/src`, and if so did I rebuild it before testing?
   A green `npm test` without that rebuild is not evidence.
2. **Contracts:** does the change add, rename, or remove a route, a persisted field, a config field,
   an error code, an MCP tool, a CLI command, or a workspace? If yes, did I move every file in the
   matching Contract Change Checklist row?
3. **Checks:** which commands did I actually run, with what result — and which ones did I skip, and
   why (no PowerShell, no network, no store credentials)? Never present an unrun check as passing.
4. **Changeset:** does the change touch a published package? If yes, is there a `.changeset/*.md`
   for it, authored via `npm run changeset` rather than by hand?
5. **Working tree:** are unrelated modified files still intact, and did I avoid committing or pushing
   unless asked?

### Do Not Do These Without Being Asked

- Commit, push, open a PR, or tag a release.
- Run `npm run version-packages`, `npm run release`, or edit a `package.json` `version` field or a
  generated `CHANGELOG.md`.
- Run bare `npm install`, upgrade a dependency, or regenerate `package-lock.json`.
- Weaken a security control (JWS/certificate verification, webhook auth, admin-secret comparison,
  ownership checks, body limits) or enable a `mockMode` / `skipJwsVerification` path outside
  development.
- Delete or raise a failing gate — a size budget, a parity test, a docs check — to make CI green.
- Call a live App Store Connect or Google Play write API. Product-management tools mutate real
  stores; propose first and wait for explicit approval.
- Copy anything from the private `onesub-unity-pro` repository into this one.

## Documentation Ownership

Each fact has one owner. Link to the owner rather than restating it.

| Document | Owns |
|---|---|
| `README.md` | Product overview, quick start, supported features, package catalog, roadmap |
| `docs/README.md` | Documentation index and routing |
| `docs/ARCHITECTURE.md` | Dependency direction, runtime flow, stores, state transitions, hooks, SDK client purchase flow |
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
| `CLAUDE.md` | A thin Claude entry point: imports this file, plus Claude Code harness notes only — no project rules |

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
