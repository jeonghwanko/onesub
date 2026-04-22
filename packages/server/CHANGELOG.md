# @onesub/server

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
