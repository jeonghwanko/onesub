# Contributing to onesub

Thanks for your interest. onesub is MIT-licensed and community contributions are welcome.

## Dev setup

```bash
git clone https://github.com/jeonghwanko/onesub.git
cd onesub
npm install
npm run build         # shared → server → sdk → mcp-server (order matters)
npm test              # vitest
npm run type-check
```

Node 20+ is required (uses `node:crypto.X509Certificate`).

## Monorepo layout

```
packages/
├── shared/      # @onesub/shared — types + constants. Everything else depends on this.
├── server/      # @onesub/server — Express middleware (receipt validation + webhooks + admin)
├── sdk/         # @onesub/sdk — React Native SDK (OneSubProvider + useOneSub + Paywall)
└── mcp-server/  # @onesub/mcp-server — MCP tools for AI integration
```

Build dependency order is enforced in [.github/workflows/ci.yml](.github/workflows/ci.yml) and in `package.json` workspaces — if you add a new package, update both.

## Coding rules

- **ESM**: every relative import must have a `.js` extension, even in `.ts` source files.
- **SSOT**: all shared types live in `@onesub/shared`. Don't redefine `AppleConfig` / `GoogleConfig` / `SubscriptionInfo` / `PurchaseInfo` anywhere else — derive from `OneSubServerConfig` instead.
- **Status strings**: use `SUBSCRIPTION_STATUS` / `PURCHASE_TYPE` constants, not string literals.
- **Store**: server accepts any `SubscriptionStore` / `PurchaseStore` implementation. In-memory is the dev default; Postgres is the prod default. If you change one interface, update both built-in stores.
- **Security**: receipt validation changes must keep or strengthen the Apple Root CA G3 chain check and the per-`transactionId` ownership check. See [docs/SECURITY.md](docs/SECURITY.md).

## Tests

- Unit tests live beside source in `__tests__/` folders.
- Integration tests that hit real Apple/Google endpoints are not run in CI — use fixtures / mocks.
- New provider behavior (Apple JWS, Google Play API) needs a unit test; look at existing `apple.test.ts` / `google.test.ts` patterns.

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
- [ ] Updated `CHANGELOG.md` for user-facing changes
- [ ] Updated `docs/MIGRATION.md` for breaking changes
- [ ] No new `any` or `// @ts-ignore` without a comment explaining why

## Reporting security issues

Do **not** open a public issue for security vulnerabilities. See [docs/SECURITY.md](docs/SECURITY.md#reporting-vulnerabilities).
