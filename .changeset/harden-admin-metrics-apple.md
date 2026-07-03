---
"@onesub/server": patch
---

Security and robustness hardening:

- **Timing-safe secret comparison**: the admin routes (`X-Admin-Secret`), metrics routes, and Apple offer-signature route (`X-Onesub-Offer-Secret`) now compare shared secrets with `crypto.timingSafeEqual` instead of `!==`, closing a byte-by-byte timing side channel. Error responses are unchanged.
- **Metrics `groupBy=day` range cap**: `/onesub/metrics/{started,expired,purchases/started}` reject `groupBy=day` requests spanning more than 366 days with `400 INVALID_INPUT` — an unbounded range previously zero-filled one bucket object per day (millions for a pathological range). Requests without `groupBy` are unaffected.
- **Apple x5c BasicConstraints enforcement**: every certificate acting as an issuer in a StoreKit JWS x5c chain (and the bundled Apple root when used as issuer) must now carry `basicConstraints CA=true`, blocking leaf-as-issuer chain splicing. The leaf itself is not required to be a CA. (keyCertSign is not checked because node's `X509Certificate.keyUsage` exposes EKU OIDs, not the KeyUsage bit string.)
- **Transaction History pagination guard**: `fetchAppleTransactionHistory` no longer loops forever when Apple responds `hasMore: true` with a missing or unchanged `revision` cursor, and pagination is capped at 50 pages (warn + partial history instead of a hung request).
