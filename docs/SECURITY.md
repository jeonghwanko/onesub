# Security Architecture

## Receipt Verification

### Apple StoreKit 2
- JWS receipts are verified against Apple's JWKS (`https://appleid.apple.com/auth/keys`) using `jose.jwtVerify()`
- `skipJwsVerification` flag available for dev/testing only. A runtime warning is logged if used in `NODE_ENV=production`
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

## Known Limitations

1. **userId is client-provided**: The `validate` endpoint trusts the `userId` from the request body. In production, extract `userId` from your auth token instead of trusting client input
2. **Single subscription per user**: Store returns only the most recent subscription per userId
3. **InMemoryStore**: For development only. No eviction policy — memory grows unbounded. Use PostgresSubscriptionStore for production

## Reporting Vulnerabilities

Please report security vulnerabilities via GitHub Issues or email.
