---
"@onesub/server": minor
"@onesub/shared": minor
---

New `productReceiptMaxAgeHours` config (Apple + Google, default 72): the one-time-purchase replay window is now configurable, so historical receipts can be validated on purpose — migrating purchasers from another IAP backend, or e2e tests against real store transactions. The 72h default and its replay-protection semantics are unchanged.

Also implements the previously-stubbed `e2e.yml` workflow: `test:e2e:apple` fetches a real Apple-signed JWS via the App Store Server API and round-trips it through receipt validation (x5c chain verification live — a tampered JWS must 422); `test:e2e:google` mints real Google OIDC identity tokens to exercise Pub/Sub push auth (audience/issuer/email), plus a real Play Developer API OAuth mint.
