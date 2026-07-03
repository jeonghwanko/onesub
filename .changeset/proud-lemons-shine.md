---
"@onesub/providers": minor
---

App Store Connect / Google Play wrapper correctness sweep.

- **Apple price points now match**: `customerPrice` (major units) is normalized against the smallest-unit target, so USD/EUR/GBP prices actually set (`499` now matches `$4.99`); zero-decimal currencies unchanged. `findApplePricePoint` accepts an optional `currency` arg; unmapped territories without it fall back to major-unit comparison.
- Empty-body 2xx responses (204 DELETE) are treated as success on both platforms instead of throwing on `JSON.parse('')`.
- Google OAuth token cache is keyed by a SHA-256 of the full service-account key — the previous 40-char prefix collided across accounts and could reuse another account's token.
- Google `subscriptions.create`/`patch` send the required `productId` and `regionsVersion.version` query params; renames merge listings so non-English locales survive.
- Apple `inAppPurchasePriceSchedules` includes the required `baseTerritory`; EUR maps to a real territory (DEU); subscription creation reuses an existing group with the same reference name and rolls back a freshly created group on failure.
- Full pagination on all list/lookup paths (Apple `links.next`, Google `nextPageToken`/`tokenPagination`) — products beyond the first page are no longer invisible.
- Error reporting: lookup helpers no longer swallow auth failures as NOT_FOUND; `listProducts` throws when both halves fail instead of returning an empty catalog; `setPrice` failures surface as `priceError`; unsupported/duplicate extra-region currencies are skipped and reported via `skippedRegions` instead of corrupting the request.
- Zero-decimal subscription prices list correctly (KRW no longer reported ×100); all requests carry a 30s timeout; ASC JWTs leave clock-skew headroom.
