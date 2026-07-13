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

## Build and Type Checks

```bash
npm run build
npm run type-check
```

The root build excludes the dashboard, so dashboard changes also require:

```bash
npm run build -w @onesub/shared
npm run type-check -w @onesub/dashboard
npm run build -w @onesub/dashboard
```

Server bundle-size changes can be checked with:

```bash
npm run size -w @onesub/server
```

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

This validates local Markdown links, trailing whitespace, npm workspace coverage in `AGENTS.md`, MCP
tool documentation, and CLI command documentation. It requires no network access.

## CI-Parity Checklist

For a cross-package change, the practical local equivalent of CI is:

```bash
npm ci
npm run build
npm test
npm run type-check
pwsh ./validate-unity-packages.ps1
npm run size -w @onesub/server
npm run build -w @onesub/dashboard
npm run docs:check
```

Use focused checks for package-local changes. Documentation-only changes normally need only
`npm run docs:check`; real store E2E runs only when provider/verification behavior warrants it.

## Adding Tests

- Put TypeScript tests beside source under a `src/**/__tests__` directory.
- Use fixtures/mocks for routine Apple/Google behavior; do not call real store APIs from PR tests.
- Add multi-step lifecycle tests when order or preserved state matters.
- Test security failures as well as success: signature, audience, ownership, app isolation, body
  limits, and production mock guards.
- Keep generated MCP output assertions aligned with the public SDK API.
- Update Unity Editor tests and the boundary validator when public Unity settings or dependencies
  change.
