# Migration Guide

Upgrade notes for breaking releases of `@onesub/server`. Minor/patch releases within the same major are drop-in.

---

## `@onesub/server` 0.6.x → 0.7.0

**What changed:** `express`가 `dependencies`에서 **`peerDependencies`로 이동**. 더 이상 `@onesub/server`가 자체 express 사본을 끌고 들어오지 않음.

지원 범위: `"^4.17.0 || ^5.0.0"` — Express 4 또는 5 모두 호환.

**Why:** middleware 라이브러리의 표준 패턴. 호스트 앱이 이미 가진 express 인스턴스와 `@onesub/server`의 Router가 같은 인스턴스를 공유하게 됨 (이중 설치 / 인스턴스 mismatch 방지).

**You're affected if:**
- `@onesub/server`만 설치하고 호스트 앱에 `express`가 없었던 경우 — install이 peer warning을 띄움. 거의 없는 케이스 (express 없이 이 미들웨어를 쓸 일이 없음).

**Action:**
```bash
npm install express          # 호스트 앱에 명시적으로 설치 (이미 있으면 no-op)
npm install @onesub/server@latest
```
- Express 4 사용자: `npm install express@^4.17.0` 후 `@onesub/server@^0.7.0` 설치 — 그대로 작동
- Express 5 사용자: `npm install express@^5` 후 동일

내부 구현은 Express 4/5 공통 API만 사용 (`Router`, `express.json`, 표준 `(req, res, next)`). 이전 0.6.4의 Express 5 강제 의존성은 풀림.

---

## `@onesub/server` 0.6.3 → 0.6.4 (지금은 0.7.0으로 직행 추천)

**What changed:** Internal upgrade from Express 4 to Express 5 — but this version pinned `express` as a regular `dependencies`. **0.7.0이 이 문제를 해결**하므로 0.6.3 사용자는 0.6.4를 건너뛰고 0.7.0으로 직행 권장.

**호환성 메모:** 0.6.4의 Router는 express 5 인스턴스를 사용. 호스트 앱이 express 4면 `(req, res, next)` 미들웨어 시그니처는 호환되지만 Router-level error handler 체인이 분리될 수 있음.

---

## `@onesub/server` 0.5.x → 0.6.x

**What changed:** Apple JWS verification now walks the full `x5c` certificate chain up to a bundled Apple Root CA (G3). Previously only the leaf certificate was used to verify the signature, so a self-signed cert could mint a JWS that passed.

**You're affected if:**
- You generate test JWS with a non-Apple-issued key in CI / local tests.
- You proxy receipts through a system that re-signs them.

**You're not affected if:**
- Your server only receives real receipts from `react-native-iap` (StoreKit 2) in production or sandbox.

**Action:**
- Production: no change required.
- Tests: stop minting fake JWS with self-signed certs. Use StoreKit 2 sandbox receipts, or mock the provider (`validateAppleConsumableReceipt`) directly.
- When Apple publishes Root CA G4, add its PEM to `packages/server/src/providers/apple-root-ca.ts` — both roots will be accepted simultaneously.

---

## `@onesub/server` 0.4.x → 0.5.x

**What changed:** `POST /onesub/purchase/validate` now rejects a `transactionId` that is already owned by a different `userId` instead of silently no-op'ing.

Previously `savePurchase` used `ON CONFLICT (transaction_id) DO NOTHING`, so the same Apple/Google `transactionId` submitted under a different `userId` would be silently dropped while the server still returned `valid: true`. This let a single receipt be reused across arbitrary accounts.

**New behavior:**
- Same `userId` + same `transactionId` → idempotent no-op (unchanged).
- Different `userId` + same `transactionId` → `HTTP 409 { error: 'TRANSACTION_BELONGS_TO_OTHER_USER' }`.
- Non-consumables only: `0.6.1+` auto-reassigns instead of rejecting, because a valid JWS (verified against Apple Root CA as of `0.6.0`) proves the caller owns the Apple account. Consumables still reject.

**You're affected if:**
- Your app reuses a cached `userId` across device reinstalls or multiple logins and previously depended on silent-skip behavior. You'll now see `409` on what used to succeed.
- You run integration tests that feed the same `transactionId` under rotating `userId`s.

**Action:**
- App: handle `409 TRANSACTION_BELONGS_TO_OTHER_USER` by showing a "이 구매는 다른 계정에 연결되어 있습니다" dialog, or upgrade to `>= 0.6.1` so non-consumable reinstalls auto-resolve.
- For legitimate device/account migrations, call the new admin endpoint:
  ```bash
  curl -X POST https://api.yourapp.com/onesub/purchase/admin/transfer \
    -H "X-Admin-Secret: $ADMIN_SECRET" \
    -H "Content-Type: application/json" \
    -d '{"transactionId":"<apple-or-google-tx>","newUserId":"new-user-id"}'
  ```
- Set `config.adminSecret` to enable `/onesub/purchase/admin/*` routes. If unset, the admin router is not mounted.

---

## `@onesub/sdk` 0.2.x → 0.3.x

**What changed:** `react-native-iap` peer dependency bumped to **v15**. v15 switched from promise-returning `requestPurchase()` to an event-based model (`purchaseUpdatedListener`). The SDK now uses the new pattern internally.

**Action:**
- `npm i react-native-iap@^15` in your app.
- No source change required if you only use `useOneSub()` — the pattern change is internal.

---

## `@onesub/shared` 0.2.x → 0.3.x

Additive only. `ValidatePurchaseResponse.action?: 'new' | 'restored'` added in `0.3.1` — optional, safe to ignore on the client.
