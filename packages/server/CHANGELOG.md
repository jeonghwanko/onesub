# @onesub/server

## 0.9.0

### Minor Changes

- 7b92dc8: 운영 안정성 보강 (Apple JWT 캐시, fetch timeout) + paused 메타데이터(autoResumeTime)

  ### Apple App Store Server API 안정성

  - **JWT 캐시**: `makeAppleApiJwt`에 모듈 레벨 캐시 + Promise dedup (Google `getCachedAccessToken`과 동일 패턴). 20분 TTL, 만료 60초 전부터 refresh. 동시 burst에서도 단일 ECDSA-sign.
    - 이전엔 매 호출마다 sign — webhook 폭주(unknown-tx fallback이 Status API 호출하는 경우 등) 시 CPU 낭비.

  ### Outbound fetch timeout

  - **`http.ts/fetchWithTimeout`** — 모든 outbound 호출에 AbortController 기반 timeout (default 10s) + caller signal 합성 + timer 자동 cleanup
  - 적용: Apple Status API / Consumption Response, Google subscriptionsv2 / products / OAuth / acknowledge×2 / consume (총 8 sites)
  - 이전엔 Node global `fetch`가 default timeout 없어 upstream hang 시 webhook도 hang → request pile-up.

  ### Google paused — autoResumeTime 메타데이터

  - **`SubscriptionInfo.autoResumeTime?: string`** 추가 (Google 전용 옵션 RFC3339)
  - `validateGoogleReceipt`가 `status === 'paused'`일 때만 v2 응답의 `pausedStateContext.autoResumeTime` 추출 (defensive — 다른 상태에 잘못 붙어 와도 무시)
  - 호스트 앱이 단순 "일시정지 중" 대신 "재개 예정: YYYY-MM-DD" UX 표시 가능

  ### Postgres

  - `onesub_subscriptions.auto_resume_time TIMESTAMPTZ` 칼럼 추가
  - `ALTER TABLE IF NOT EXISTS`로 기존 설치 자동 backfill

  ### 인프라 / 위생

  - `.gitattributes` 추가 — `*.ts`/`*.sql`/`*.md` 등 text 소스를 LF로 강제. Windows `core.autocrlf` 환경에서 schema parity test가 silently fail하던 문제 영구 fix
  - `schema.test.ts` `normalize` 함수에 `\r` 제거 — 위와 동일 cross-platform 안전망

  ### 동작 변경

  없음. 모두 additive 또는 internal hardening.

### Patch Changes

- Updated dependencies [7b92dc8]
  - @onesub/shared@0.5.0

## 0.8.0

### Minor Changes

- fb1af23: 구독/IAP 라이프사이클 보강 — 새 상태(grace_period/on_hold/paused), 환불 정책, Google v2 API 마이그레이션, Apple Subscription Status API 직접 조회

  ### Apple

  - **App Store Server API 직접 조회** (`fetchAppleSubscriptionStatus`) — webhook 유실/순서 꼬임 시 복구. webhook의 unknown-transaction 분기에서도 자동 fallback fetch
  - **`BILLING_RETRY` / `GRACE_PERIOD_EXPIRED` 매핑** — `DID_FAIL_TO_RENEW` (subtype 분기), `GRACE_PERIOD_EXPIRED` 정확히 처리
  - **`CONSUMPTION_REQUEST` 응답 API** — `apple.consumptionInfoProvider` hook으로 환불 결정에 사용량 정보 제공
  - **IAP `REFUND` 처리** — `PurchaseStore.deletePurchaseByTransactionId`로 정확한 단일 row 삭제 (구독 환불과 분리)
  - **`type`/`environment`/`bundleId`/`transactionId` 노출** — `decodeAppleNotification` 반환 확장

  ### Google

  - **Play Developer API v1 → v2 마이그레이션** (`subscriptionsv2.get`) — `subscriptionState` enum 직접 매핑으로 grace_period/on_hold/paused 정확히 잡음 (이전 v1은 expiry/cancelReason 추정)
  - **`acknowledgePurchase` 자동 호출** (구독 + non-consumable IAP) — 미호출 시 3일 내 자동 환불 위험 해결
  - **`voidedPurchasesNotification` 핸들러** — productType=1(구독)은 status 변경, productType=2(IAP)는 row 삭제
  - **`SUBSCRIPTION_PAUSED` (10) → 새 `paused` 상태** — 사용자 의지 일시정지, `on_hold`(결제 실패)와 구분
  - **`SUBSCRIPTION_PRICE_CHANGE_CONFIRMED` (8)** + `google.onPriceChangeConfirmed` hook
  - **`linkedPurchaseToken` 체인 추적** — 업그레이드/다운그레이드 시 이전 record의 userId 자동 인계 (continuity)

  ### 라이프사이클 상태 확장

  `SubscriptionStatus`에 추가:

  - `grace_period`: 결제 실패지만 store가 entitlement 유지 — `active`로 분류 (status route)
  - `on_hold`: grace 끝, retry 중 — entitlement 회수
  - `paused`: 사용자 의지 일시정지 (Google) — entitlement 회수, UX는 `on_hold`와 별개

  > **호환성**: 호스트 앱이 `switch (status)` exhaustive로 다루면 새 case 추가 필요. string 비교만 하면 무영향.

  ### 환불 정책

  `OneSubServerConfig.refundPolicy?: 'immediate' | 'until_expiry'` (default `'immediate'`):

  - 구독 환불 시 즉시 status=canceled (default) vs 만료까지 entitlement 유지
  - IAP는 정책 무관 — 항상 즉시 삭제 (만료 개념 없음)

  ### Status route 안전망

  `active` 판정에 `expiresAt > now` 체크 추가 — `until_expiry` 모드 자연 만료 + EXPIRED webhook 유실 대비 stale-record backstop.

  ### Postgres

  `onesub_subscriptions.linked_purchase_token TEXT` 칼럼 추가. `ALTER TABLE IF NOT EXISTS`로 기존 설치 자동 backfill.

  ### 동작 변경 (worth noting)

  - `validateGoogleReceipt`가 PAUSED 상태를 `'paused'` 반환 (이전 `'on_hold'`)
  - Google webhook의 grace_period 알림이 `grace_period` 상태로 정확히 분류 (이전엔 잘못 `active`로)
  - Google webhook의 on_hold 알림이 `on_hold` 상태로 정확히 분류 (이전엔 무처리)
  - Apple/Google 구독 환불 알림 시 `status='canceled'` (이전 동작 유지) — `refundPolicy='until_expiry'`로 옵트인 변경 가능

### Patch Changes

- Updated dependencies [fb1af23]
  - @onesub/shared@0.4.0

## 0.7.3

### Patch Changes

- 35b7ca1: 오픈소스 채택의 진입장벽을 낮추기 위한 2단계 작업 + 보안/버그 fix.

  **@onesub/shared**:

  - `MOCK_RECEIPT_PREFIX` 상수 export — 테스트 시나리오별 prefix (REVOKED / EXPIRED / INVALID / BAD_SIG / NETWORK_ERROR / SANDBOX)
  - `OneSubServerConfig.apple.mockMode` + `.google.mockMode` 필드 추가

  **@onesub/server**:

  - 신규 `providers/mock.ts` — Apple/Google API 없이 동작하는 mock 구현. receipt 문자열 prefix로 시나리오 결정, `sha256(receipt)` 기반 결정적 transactionId
  - `validateAppleReceipt` / `validateAppleConsumableReceipt` / `validateGoogleReceipt` / `validateGoogleProductReceipt`가 `config.*.mockMode` 체크 후 mock으로 분기
  - **보안 가드**: `NODE_ENV=production` + `mockMode: true` 조합 시 `createOneSubMiddleware`가 hard throw. mockMode는 임의 영수증을 valid로 받아서 프로덕션에서 실수로 켜지면 사기 피해
  - **버그 fix**: Admin auth 미들웨어가 호스트 앱의 모든 라우트(예: `/health`)를 401로 가로채던 오래된 버그. `router.use(authMw)` → `router.use('/onesub/purchase/admin', authMw)` 로 path-scoped. 회귀 테스트 추가
  - `GoogleProductResult` mock 파라미터명 `purchaseToken` → `receipt`로 real provider와 통일

  **@onesub/cli**:

  - 신규 `onesub dev [--port N]` 서브커맨드 — in-memory 스토어 + 양쪽 mockMode의 onesub 서버를 1줄로 기동. Apple/Google 자격증명 없이 `POST /onesub/validate` / `POST /onesub/purchase/validate` / 웹훅까지 전 플로우 로컬 검증 가능
  - 127.0.0.1로만 bind (ngrok/포트포워드 실수로 dev-admin-secret 노출 방지)
  - `@onesub/server` + `express` runtime dep 추가 (dev 명령만 사용, lazy import로 init 명령 실행 시에는 로드 안 함)

  **사용 예**:

  ```bash
  npx @onesub/cli dev
  # → http://localhost:4100 — Apple/Google 없이 바로 curl 테스트 가능
  curl -X POST http://localhost:4100/onesub/purchase/validate \
    -H "Content-Type: application/json" \
    -d '{"platform":"apple","receipt":"MOCK_VALID_x","userId":"u1","productId":"prem","type":"non_consumable"}'
  # → { "valid": true, "action": "new", ... }

  # 에러 시나리오 재현
  -d '{"...","receipt":"MOCK_REVOKED_x", ...}'
  # → 422 { "errorCode": "RECEIPT_VALIDATION_FAILED" }
  ```

  tests: 140 → 165 (+25 신규 — classifyMockReceipt 8 cases / mock validators 11 cases / HTTP integration 5 cases / prod guard 1 case / admin middleware scope regression 1 case).

- Updated dependencies [35b7ca1]
  - @onesub/shared@0.3.5

## 0.7.2

### Patch Changes

- Updated dependencies [63580dc]
  - @onesub/shared@0.3.4

## 0.7.1

### Patch Changes

- 636ce9f: 구조화된 에러 코드 시스템 추가 — 오픈소스 소비자가 프로그램으로 에러를 분기할 수 있도록.

  **@onesub/shared**: `ONESUB_ERROR_CODE` 상수 + `OneSubErrorCode` 타입 (26개 코드). 모든 response 타입에 `errorCode: OneSubErrorCode` 필드 추가 (기존 `error: string`은 하위호환 유지).

  **@onesub/server**: validate / status / purchase / webhook / admin 모든 에러 응답에 `errorCode` 포함. 신규 `errors.ts`의 `sendError(res, status, code, msg)` / `sendZodError(res, err)` 헬퍼로 15+ 중복 블록 통합.

  **@jeonghwanko/onesub-sdk**: `OneSubError` 클래스 + `isOneSubError` / `toOneSubError` / `isOneSubErrorCode` 가드 export. SDK가 throw하는 모든 에러(timeout / cancel / concurrent / validation / no-receipt 등)가 `OneSubError` 인스턴스 — `.code`로 분기 가능.

  소비자 사용 예:

  ```ts
  import { OneSubError, ONESUB_ERROR_CODE } from "@jeonghwanko/onesub-sdk";

  try {
    await purchaseProduct("premium", "non_consumable");
  } catch (err) {
    if (err instanceof OneSubError) {
      switch (err.code) {
        case ONESUB_ERROR_CODE.USER_CANCELLED:
          return;
        case ONESUB_ERROR_CODE.NON_CONSUMABLE_ALREADY_OWNED:
          return showAlert("이미 구매한 상품입니다.");
        default:
          return showAlert("결제 실패");
      }
    }
    throw err;
  }
  ```

  검증: 28개 신규 테스트 추가 (OneSubError 10 + purchaseFlow 에러코드 5 + 서버 HTTP 13), 총 104 → 132 pass.

- Updated dependencies [636ce9f]
  - @onesub/shared@0.3.3

## 0.7.0

### Minor Changes

- df8dbf0: `@onesub/server`: `express`를 `peerDependencies`로 이동 (`"^4.17.0 || ^5.0.0"`).

  Middleware 라이브러리의 표준 패턴 — 호스트 앱이 가진 express 인스턴스를 그대로 사용하므로 이중 설치 / Router 인스턴스 mismatch 문제가 사라집니다. Express 4와 5 모두 지원.

  설치 시 호스트 앱에 `express`를 명시적으로 두세요:

  ```bash
  npm install @onesub/server express
  ```

  자세한 마이그레이션은 [`docs/MIGRATION.md`](https://github.com/jeonghwanko/onesub/blob/master/docs/MIGRATION.md)의 `0.6.x → 0.7.0` 섹션 참조.

  `@onesub/cli`: 생성 템플릿의 `@onesub/server` 버전 핀을 `^0.7.0`으로 갱신.

## 0.6.4

### Patch Changes

- e0b4da2: express 4 → 5 upgrade. Internal: admin DELETE route now validates params via zod (Express 5 types route params as `string | string[]`). No public API change.

## 0.6.3

### Patch Changes

- a62f241: OSS readiness pass: pluggable logger (`OneSubServerConfig.logger` / `setLogger`), canonical Postgres `sql/schema.sql` with runtime parity test, webhook retry semantics documented (4xx vs 5xx), per-package READMEs for npm, new `@onesub/cli` scaffolding package (`npx @onesub/cli init`), Apple Root CA G3 bundle protected by unit tests.

  No API breakage — all additions are backward compatible.

- Updated dependencies [a62f241]
  - @onesub/shared@0.3.2
