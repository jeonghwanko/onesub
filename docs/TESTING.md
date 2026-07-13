# Testing Guide

OneSub separates deterministic repository tests, local mock lifecycle testing, dashboard/Unity
checks, and credentialed Apple/Google E2E tests. Use the lowest-cost layer that proves the change.

## Repository Test Suite

Vitest discovers `packages/*/src/**/__tests__/**/*.test.ts` in a Node environment.

```bash
# All TypeScript tests
npm test

# One file
npm test -- packages/server/src/__tests__/apps.test.ts

# A related group
npm test -- packages/server/src/__tests__/webhook-google.test.ts \
  packages/server/src/__tests__/google-subscriptions-v2.test.ts
```

Do not document a fixed test count; it changes frequently. A feature is covered by the relevant
behavioral assertions, not by a repository-wide number.

### Contract parity tests

Two tests assert that a contract's two halves still agree. They fail on *drift*, not on broken
behavior, and their message reads as a puzzle unless you know that:

| Test | Asserts | Fails when |
|---|---|---|
| `packages/server/src/__tests__/openapi.test.ts` | Every mounted route is documented in `packages/server/src/openapi.ts`, and every documented path is actually mounted | You added, renamed, or removed a route without editing the spec |
| `packages/server/src/__tests__/schema.test.ts` | `packages/server/sql/schema.sql` matches the DDL constants in `packages/server/src/stores/schema.ts` | You changed a persisted column in only one of the two |

The schema test strips SQL comments, collapses whitespace, and does a normalized substring check — it
also strips `\r` first, so a CRLF checkout does not break it.

## Build and Type Checks

```bash
npm run build
npm run type-check
```

After editing `packages/shared/src`, rebuild it before anything downstream is meaningful — dependents
read `packages/shared/dist`, which is gitignored and never rebuilt automatically:

```bash
npm run build -w @onesub/shared
```

`tsc` usually catches a stale `dist` loudly, because the stale `.d.ts` ships with it. `npm test` does
not — Vitest transpiles without type-checking, so a value export missing from the stale `dist` is
simply `undefined` at runtime. A green test run on an unbuilt shared change proves nothing.

The root build excludes the dashboard, so dashboard changes also require:

```bash
npm run build -w @onesub/shared
npm run type-check -w @onesub/dashboard
npm run build -w @onesub/dashboard
```

Server bundle size is a required CI check. It measures the emitted files, so it needs a build first:

```bash
npm run build -w @onesub/server
npm run size -w @onesub/server
```

It gates the gzipped ESM and CJS bundles against the ceilings in `packages/server/.size-limit.cjs`.
If a deliberate surface addition exceeds a ceiling, raise the limit there and add a dated comment
recording the reason and the measured size, following the existing entry. Do not delete the check or
a budget entry to make it pass.

## Local Mock Provider

Build the current checkout and start its mock server:

```bash
npm run build
node packages/cli/dist/index.js dev --port 4100
```

The server listens only on loopback and stores state in memory. It exercises normal validation and
store routes without store credentials.

### Mock receipt outcomes

| Receipt prefix | Outcome |
|---|---|
| `MOCK_VALID...` or any unrecognized value | Valid deterministic receipt |
| `MOCK_SANDBOX...` | Valid subscription with a short sandbox-like expiry |
| `MOCK_REVOKED...` | Rejected as revoked/refunded |
| `MOCK_EXPIRED...` | Rejected as expired |
| `MOCK_INVALID...` | Rejected as invalid |
| `MOCK_BAD_SIG...` | Rejected as bad signature/integrity |
| `MOCK_NETWORK_ERROR...` | Throws a simulated upstream network failure |

The same receipt produces the same transaction ID, which makes replay/idempotency tests stable.
Append `#token=<value>` to exercise account-binding validation.

### Subscription request

```bash
curl -X POST http://localhost:4100/onesub/validate \
  -H "Content-Type: application/json" \
  -d '{"platform":"google","receipt":"MOCK_VALID_sub","userId":"u1","productId":"pro_monthly"}'
```

### One-time purchase request

```bash
curl -X POST http://localhost:4100/onesub/purchase/validate \
  -H "Content-Type: application/json" \
  -d '{"platform":"apple","receipt":"MOCK_VALID_lifetime","userId":"u1","productId":"lifetime","type":"non_consumable"}'
```

### Inspect state

```bash
curl "http://localhost:4100/onesub/status?userId=u1"
curl "http://localhost:4100/onesub/purchase/status?userId=u1"
```

For multi-app validation, add `"appId":"configured-id"` to the POST body. Unknown explicit IDs
must fail rather than use another app's credentials.

## MCP-Driven Lifecycle Tests

With `@onesub/mcp-server` connected, use:

- `onesub_simulate_purchase` to submit mock validation scenarios.
- `onesub_simulate_webhook` to drive Apple/Google lifecycle transitions.
- `onesub_inspect_state` to read subscription and purchase state afterward.

Example prompt:

```text
Against http://localhost:4100, simulate a Google purchase for user u1 and product pro_monthly.
Transition it to grace_period, inspect the user's state, and report every observed status.
```

Simulated Apple webhook payloads rely on the CLI dev server's development-only
`skipJwsVerification`. Never reproduce that configuration in a production process.

## Credentialed Apple E2E

```bash
npm run build
npm run test:e2e:apple -w @onesub/server
```

Required environment variables:

| Variable | Purpose |
|---|---|
| `APPLE_BUNDLE_ID` | Expected application bundle ID |
| `APPLE_KEY_ID` | App Store Server API key ID |
| `APPLE_ISSUER_ID` | App Store Connect issuer ID |
| `APPLE_PRIVATE_KEY` | ES256 `.p8` key contents |
| `APPLE_E2E_TRANSACTION_ID` | Real sandbox or production transaction used for read-only history fetch |

The script fetches real signed transaction history, validates the JWS through the normal server
route, writes only to in-memory stores, and verifies that a tampered JWS is rejected.

## Credentialed Google E2E

```bash
npm run build
npm run test:e2e:google -w @onesub/server
```

| Variable | Required | Purpose |
|---|---|---|
| `GOOGLE_PACKAGE_NAME` | Yes | Play application ID |
| `GOOGLE_SERVICE_ACCOUNT_KEY` | Yes | Service-account JSON string |
| `GOOGLE_E2E_PUSH_AUDIENCE` | No | Audience for the real Google-signed OIDC token |
| `GOOGLE_E2E_PURCHASE_TOKEN` | No | Enables real purchase-token validation |
| `GOOGLE_E2E_PRODUCT_ID` | No | Product ID paired with the optional token |

The script verifies Google OIDC signature/audience/email handling, rejects missing/wrong-audience
tokens, and optionally validates a real purchase. It is intentionally not part of normal PR CI.
Use the manual `.github/workflows/e2e.yml` workflow for repository-managed secrets.

## Unity Tests

Run the repository-level package-boundary check:

```bash
pwsh ./validate-unity-packages.ps1
```

Run `packages/unity/Tests/Editor` with Unity Test Framework in Unity 2022.3 for C# behavior changes.
The boundary script does not execute Unity Editor tests; it verifies package names, versions,
assembly references, dependencies, and separation of optional platform services.

## Documentation Checks

```bash
npm run docs:check
```

This validates local Markdown links and referenced file paths, trailing whitespace, npm workspace
coverage in `AGENTS.md`, MCP tool documentation, CLI command documentation, and the route list in
`packages/server/README.md` against `packages/server/src/openapi.ts` — which `openapi.test.ts` in turn
holds to the actually mounted routers. It requires no network access and no `npm ci`.

If you add a check, add its inputs to the `paths` filter in `.github/workflows/docs.yml` too, or it
will not run on the change that breaks it.

## CI-Parity Checklist

For a cross-package change, the practical local equivalent of CI is:

```bash
npm ci
npm run build
npm test
npm run type-check
pwsh ./validate-unity-packages.ps1
npm run size -w @onesub/server

# the dashboard is a separate CI job — it can be red while the root build is green
npm run build -w @onesub/shared
npm run type-check -w @onesub/dashboard
npm run build -w @onesub/dashboard

npm run docs:check
```

This is a superset of CI, not a mirror of it. CI's `ci.yml` job runs `npm ci` → `build` → `test` →
the Unity validator → the size check; it never runs root `npm run type-check`, because `build` is the
type gate. `docs:check` runs in its own path-filtered workflow, and CodeQL (`security-extended`) runs
separately and can fail a PR.

Use focused checks for package-local changes. Documentation-only changes normally need only
`npm run docs:check` — `ci.yml` sets `paths-ignore: '**/*.md'`, so a Markdown-only PR runs no build
and no tests (CodeQL still runs; it has no path filter). Real store E2E runs only when
provider/verification behavior warrants it.

## When a Check Goes Red

| Symptom | Usually means |
|---|---|
| Type error on `@onesub/shared` symbols inside another package | You edited `packages/shared/src` and did not run `npm run build -w @onesub/shared` |
| A shared constant is `undefined` at runtime, no error thrown | The same stale `dist`, in its silent form |
| `openapi.test.ts` fails | A route and `openapi.ts` disagree — one side of a contract moved |
| `schema.test.ts` fails | `sql/schema.sql` and the embedded DDL constants in `stores/schema.ts` disagree |
| `npm run size` fails with a missing file | You did not build `@onesub/server` first |
| `npm run size` fails on the budget | Shrink the addition, or raise the ceiling in `.size-limit.cjs` with a dated justification |
| CI red but the whole root build is green locally | The separate `dashboard` job — run the three dashboard commands |
| `docs:check` fails after a rename | A document cites the old path; `docs.yml` is path-filtered and will not have caught it earlier |

## Adding Tests

- Put TypeScript tests beside source under a `src/**/__tests__` directory.
- There is no `fixtures/` directory. Drive deterministic Apple/Google behavior through
  `packages/server/src/providers/mock.ts` — selected by `apple.mockMode` / `google.mockMode` in the
  config you pass to the middleware, and keyed on the receipt prefixes in the table above — together
  with `packages/server/src/__tests__/test-utils.ts`. Do not call real store APIs from PR tests.
- Add multi-step lifecycle tests when order or preserved state matters.
- Test security failures as well as success: signature, audience, ownership, app isolation, body
  limits, and production mock guards.
- Keep generated MCP output assertions aligned with the public SDK API.
- Update Unity Editor tests and the boundary validator when public Unity settings or dependencies
  change.
