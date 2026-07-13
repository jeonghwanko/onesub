# Contributing to onesub

Thanks for your interest. onesub is MIT-licensed and community contributions are welcome.

## Dev setup

```bash
git clone https://github.com/jeonghwanko/onesub.git
cd onesub
npm install
npm run build         # shared → providers → server → sdk → mcp-server → cli
npm test              # vitest
npm run type-check
npm run docs:check      # local links + documented workspace/tool/CLI coverage
```

Node 20+ is required (uses `node:crypto.X509Certificate`).

## Monorepo layout

```
packages/
├── shared/                  # @onesub/shared — canonical types + constants
├── providers/               # @onesub/providers — App Store Connect + Google Play product APIs
├── server/                  # @onesub/server — Express validation, webhooks, stores, admin APIs
├── sdk/                     # @jeonghwanko/onesub-sdk — React Native provider, hook, and paywall
├── mcp-server/              # @onesub/mcp-server — AI integration and simulation tools
├── cli/                     # @onesub/cli — starter-project scaffolding
├── dashboard/               # @onesub/dashboard — private Next.js workspace, released as Docker
├── unity/                   # com.onesub.unity — public Unity purchasing Core (UPM)
└── unity-platform-services/ # optional Unity sharing/review/social helpers (UPM)
```

The root build covers the publishable TypeScript packages but intentionally skips the Next.js
dashboard. CI builds and type-checks the dashboard separately. The two Unity directories are UPM
packages rather than npm workspaces and are checked by `validate-unity-packages.ps1`.

If you add a package, update the root workspace/build configuration, CI coverage, the package map in
[`AGENTS.md`](AGENTS.md), and the package catalog in [`README.md`](README.md).

## Coding rules

- **ESM**: every relative import must have a `.js` extension, even in `.ts` source files.
- **SSOT**: all shared types live in `@onesub/shared`. Don't redefine `AppleConfig` / `GoogleConfig` / `SubscriptionInfo` / `PurchaseInfo` anywhere else — derive from `OneSubServerConfig` instead.
- **Status strings**: use `SUBSCRIPTION_STATUS` / `PURCHASE_TYPE` constants, not string literals.
- **Store**: server accepts any `SubscriptionStore` / `PurchaseStore` implementation. In-memory is the dev default; Postgres and Redis are built in for durable/multi-instance deployments. If you change an interface, update all three implementations.
- **Security**: receipt validation changes must keep or strengthen the Apple Root CA G3 chain check and the per-`transactionId` ownership check. See [docs/SECURITY.md](docs/SECURITY.md).
- **Multi-app isolation**: unknown `appId` values must fail closed; never validate a receipt with another app's credentials.
- **Unity boundary**: purchasing stays in `packages/unity`; sharing, review, leaderboard, and auth helpers stay in `packages/unity-platform-services`. See [docs/UNITY-PRO.md](docs/UNITY-PRO.md).

## Tests

- Unit tests live beside source in `__tests__/` folders.
- Integration tests that hit real Apple/Google endpoints are not run in CI — use fixtures / mocks.
- New provider behavior (Apple JWS, Google Play API) needs a unit test; look at existing `apple.test.ts` / `google.test.ts` patterns.

For dashboard changes, also run:

```bash
npm run build -w @onesub/shared
npm run type-check -w @onesub/dashboard
npm run build -w @onesub/dashboard
```

For either Unity package, run `pwsh ./validate-unity-packages.ps1` and the relevant Unity Editor
tests when a Unity project is available.

## Versioning + changelog (Changesets)

Version bumps and `CHANGELOG.md` entries are managed by [Changesets](https://github.com/changesets/changesets). **Do not hand-edit `package.json` `version` fields or per-package `CHANGELOG.md` files.**

When your PR changes a published package:

```bash
npm run changeset
```

- Pick the affected package(s).
- Pick the bump type — `patch` / `minor` / `major`.
- Write a one-line summary; it becomes the CHANGELOG entry.
- Commit the generated `.changeset/*.md` file with your PR.

On merge to `master`, the `Release` workflow opens a **"Version Packages"** PR that consumes the pending changesets, bumps versions, and updates CHANGELOGs. Merging that PR publishes to npm.

**Breaking changes** (`major`) additionally require a section in [docs/MIGRATION.md](docs/MIGRATION.md) — the changeset summary is not enough.

Docs-only, test-only, CI-only, or `examples/*` changes don't need a changeset.

## PR checklist

- [ ] `npm run build` succeeds
- [ ] `npm test` passes
- [ ] `npm run type-check` clean
- [ ] `npm run docs:check` succeeds when documentation or documented surfaces changed
- [ ] Added a changeset for changes to published packages
- [ ] Updated `docs/MIGRATION.md` for breaking changes
- [ ] Updated public/package docs for changed APIs, configuration, or package boundaries
- [ ] No new `any` or `// @ts-ignore` without a comment explaining why

## Reporting security issues

Do **not** open a public issue for security vulnerabilities. See [docs/SECURITY.md](docs/SECURITY.md#reporting-vulnerabilities).
