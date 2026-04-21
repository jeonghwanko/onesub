# Security Architecture

## Receipt Verification

### Apple StoreKit 2
- JWS signature verified with the leaf certificate from the `x5c` header
- **Full certificate chain verified up to Apple Root CA G3** (as of `@onesub/server@0.6.0`) using `node:crypto.X509Certificate` — each cert in the chain must be signed by the next, be within its validity window, and the final cert must be issued by a bundled Apple root. Leaf-only verification was insufficient because a self-signed cert could mint a passing signature
- Sandbox receipts rejected in `NODE_ENV=production` unless `ONESUB_ALLOW_SANDBOX=true` is set (for TestFlight / pre-launch QA)
- 72-hour receipt age limit enforced
- Apple webhooks accept only `signedPayload` JWS format. Pre-decoded payloads are rejected

### Google Play Billing
- OAuth2 service account JWT assertion for Play Developer API v3
- Token caching with thundering-herd protection (promise deduplication)
- Webhook JWT verification via Google's JWKS when `pushAudience` is configured

## Input Validation
- All `/onesub/validate` inputs validated via zod schema
- `receipt`: max 10,000 chars
- `userId`: max 256 chars
- `productId`: max 256 chars
- `platform`: enum `['apple', 'google']`
- Request body size limited to 50KB (`express.json({ limit: '50kb' })`)

## Authentication

### Webhook Endpoints
- **Apple**: Only JWS-signed `signedPayload` accepted. Signature verified via Apple JWKS
- **Google**: When `pushAudience` is configured, `Authorization: Bearer` JWT is verified against Google JWKS with audience claim check

### Validate / Status Endpoints
- Currently open by design (consumer adds their own auth middleware)
- Recommended: Add auth middleware when mounting:
  ```ts
  app.use('/onesub', yourAuthMiddleware, createOneSubMiddleware(config));
  ```

## Transaction Ownership

As of `@onesub/server@0.5.0`, `POST /onesub/purchase/validate` enforces a per-`transactionId` owner:

- Same `userId` + same `transactionId` → idempotent
- Different `userId` + consumable → `409 TRANSACTION_BELONGS_TO_OTHER_USER`
- Different `userId` + non-consumable → auto-reassigned to the new `userId` (as of `0.6.1`) because a JWS verified against Apple Root CA proves the caller owns the original Apple account

Before `0.5.0`, `savePurchase` silently no-op'd on duplicate `transactionId`, letting one receipt pass validation under arbitrary `userId`s.

Legitimate account/device migrations should go through `POST /onesub/purchase/admin/transfer` (requires `config.adminSecret` + `X-Admin-Secret` header).

## Admin Routes

Mounted only when `config.adminSecret` is set. Every request requires a matching `X-Admin-Secret` header (`401` otherwise). These routes bypass receipt verification — treat the secret like a database password.

## Known Limitations

1. **userId is client-provided**: The `validate` endpoint trusts the `userId` from the request body. In production, extract `userId` from your auth token instead of trusting client input
2. **Single subscription per user**: Store returns only the most recent subscription per userId
3. **InMemoryStore**: For development only. No eviction policy — memory grows unbounded. Use PostgresSubscriptionStore for production

## Reporting Vulnerabilities

**Do not open a public issue.** Report via [GitHub Security Advisories](https://github.com/jeonghwanko/onesub/security/advisories/new) so a fix can ship before the details are public.

Please include:
- Affected package(s) and version(s)
- Minimal reproduction (redact any real `JWS` / `purchaseToken` / `sharedSecret`)
- Suggested severity (low / medium / high / critical) and your reasoning
