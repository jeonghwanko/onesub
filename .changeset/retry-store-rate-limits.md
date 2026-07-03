---
"@onesub/providers": patch
---

Retry HTTP 429/503 in the Apple and Google request helpers (`appleRequest`, `playRequest`, and the Google OAuth token fetch): up to 2 retries, honoring a numeric `Retry-After` header (capped at 30s) with 1s/4s exponential backoff otherwise. App Store Connect hourly rate limits tripped by bulk operations (multi-region price setting paginates the full price-point list per region) previously surfaced as generic errors or a silent `priceSet: false`; exhausted retries still throw the exact same error shapes, so downstream `translateAppleError` / UNKNOWN handling is unchanged. Apple regenerates the ES256 JWT (and Google re-signs the OAuth assertion) on every retry attempt.
