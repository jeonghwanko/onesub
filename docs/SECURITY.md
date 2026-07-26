# Security Architecture

## Receipt Verification

### Apple StoreKit 2
- JWS signature verified with the leaf certificate from the `x5c` header
- **Full certificate chain verified up to Apple Root CA G3** (as of `@onesub/server@0.6.0`) using `node:crypto.X509Certificate` — each cert in the chain must be signed by the next, be within its validity window, and the final cert must be issued by a bundled Apple root. Leaf-only verification was insufficient because a self-signed cert could mint a passing signature
- The result of a **successful** chain verification is memoised per process, keyed on the full `x5c`
  chain plus the JWS `alg`, so repeated receipts and webhooks reuse the imported leaf key instead of
  re-walking the chain. A failed verification is never cached — an untrusted chain is rejected on
  every attempt. An entry's lifetime is capped by the earliest `notAfter` in the chain it came from,
  so an expired certificate is never honoured from cache, and by a 1-hour ceiling. The cache is
  process-local by design and is not affected by the Redis-backed `cache` adapter. Note that
  certificate **revocation** is not checked, before or after this change
- Sandbox receipts rejected in `NODE_ENV=production` unless `ONESUB_ALLOW_SANDBOX=true` is set (for TestFlight / pre-launch QA)
- One-time-purchase receipt age limit, defaulting to 72 hours. It is a default, not an invariant: a
  host can raise or disable it with `apple.productReceiptMaxAgeHours` (see `docs/CONFIGURATION.md`)
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
- optional `appId`: max 256 chars; unknown explicit IDs fail closed in multi-app mode
- `platform`: enum `['apple', 'google']`
- Request body size limited to 50KB (`express.json({ limit: '50kb' })`)

## Authentication

### Webhook Endpoints
- **Apple**: Only JWS-signed `signedPayload` accepted. The embedded `x5c` certificate chain is
  validated to the pinned Apple Root CA G3, then the leaf key verifies the payload signature
- **Google**: When `pushAudience` is configured, `Authorization: Bearer` JWT is verified against
  Google JWKS with audience claim check. **When no configured app sets it, an unattributable request
  is refused with 401 under `NODE_ENV=production`** (`@onesub/server@0.27.0`), unless
  `google.allowUnauthenticatedWebhook` is set — which is only correct when something in front of the
  server already authenticates the request. Outside production the route still accepts
  unauthenticated requests, matching how the mockMode guard and sandbox-receipt rejection are gated.

  Why refusing rather than masking the ids. The exposure was never forged entitlement — the
  subscription paths re-fetch state from Google before writing — but *revocation*: the voided-purchase
  path acts on the payload alone, so a caller who knew a `purchaseToken` or `orderId` could cancel a
  subscription or delete a one-time purchase row. Those ids cannot be protected by treating them as
  secrets. For a Google subscription the purchase token **is** the record's `originalTransactionId`,
  deliberately, because RTDNs and `linkedPurchaseToken` chains carry nothing else — so it is in the
  database, in every notification payload, and in the logs that investigate it. Refusing requests that
  cannot be attributed to Google removes the capability instead of hiding its key.

  Earlier steps on the same path: `0.21.2` added the startup warning, and `0.22.0` mounts the route
  only when the config serves Google Play at all, so an Apple-only deployment does not expose it

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

Mounted only when `config.adminSecret` is set. Every request requires a matching `X-Admin-Secret`
header (`401` otherwise). Purchase grant/transfer/delete routes can mutate ownership without a new
receipt, and the same secret gates subscription detail, metrics, Apple sync, and webhook dead-letter
operations. Treat it like a database password.

The Apple promotional-offer route uses `X-Onesub-Offer-Secret` with the same value when
`adminSecret` is configured. Without `adminSecret`, the host must protect that route with its own
authentication middleware.

## Known Limitations

1. **Host authentication is required**: validation and status routes do not authenticate end users,
   and validation accepts a client-provided `userId`. Mount host authentication and derive `userId`
   server-side when exposing these routes publicly
2. **In-memory stores/cache**: Development and single-process use only. State is lost on restart and
   maps have no eviction policy. Use PostgreSQL or Redis stores and Redis-backed cache/idempotency for
   durable or multi-instance deployments
3. **Mock/degraded verification modes**: `apple.mockMode`, `google.mockMode`, and
   `skipJwsVerification` are for local testing only. Mock provider modes are rejected when
   `NODE_ENV=production`; do not rely on environment guards as a substitute for production config review
4. **No rate limiting**: the only built-in request bound is the 50 kb JSON body cap. The
   unauthenticated validation routes are the most expensive ones — JWS verification, and on the Google
   path an outbound store API call — so request volume must be limited by the host, at the proxy or in
   Express. Webhook routes are the exception and should not be volume-limited: shedding them can
   permanently lose a state transition once Apple/Google exhaust their retries. Their correct control is
   caller authentication, which for Google means configuring `pushAudience` — without it the Google
   webhook has no way to attribute a request and refuses it in production. See *Request Limits* in
   [DEPLOYMENT.md](./DEPLOYMENT.md)

## Reporting Vulnerabilities

**Do not open a public issue.** Report via [GitHub Security Advisories](https://github.com/jeonghwanko/onesub/security/advisories/new) so a fix can ship before the details are public.

Please include:
- Affected package(s) and version(s)
- Minimal reproduction (redact any real `JWS` / `purchaseToken` / `sharedSecret`)
- Suggested severity (low / medium / high / critical) and your reasoning
