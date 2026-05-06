# @onesub/cli

## 0.1.18

### Patch Changes

- Updated dependencies
  - @onesub/server@0.13.0
  - @onesub/shared@0.8.0

## 0.1.17

### Patch Changes

- Updated dependencies
  - @onesub/shared@0.7.6
  - @onesub/server@0.12.1

## 0.1.16

### Patch Changes

- Updated dependencies [4cf6c6c]
  - @onesub/server@0.12.0
  - @onesub/shared@0.7.5

## 0.1.15

### Patch Changes

- Updated dependencies [b7afee1]
  - @onesub/shared@0.7.4
  - @onesub/server@0.11.4

## 0.1.14

### Patch Changes

- Updated dependencies [f4ef21f]
  - @onesub/shared@0.7.3
  - @onesub/server@0.11.3

## 0.1.13

### Patch Changes

- Updated dependencies [bc1c343]
  - @onesub/shared@0.7.2
  - @onesub/server@0.11.2

## 0.1.12

### Patch Changes

- Updated dependencies [8345e13]
  - @onesub/shared@0.7.1
  - @onesub/server@0.11.1

## 0.1.11

### Patch Changes

- Updated dependencies [05ac535]
  - @onesub/shared@0.7.0
  - @onesub/server@0.11.0

## 0.1.10

### Patch Changes

- Updated dependencies [10c5d0a]
  - @onesub/shared@0.6.0
  - @onesub/server@0.10.0

## 0.1.9

### Patch Changes

- Updated dependencies [9a89288]
  - @onesub/server@0.9.1

## 0.1.8

### Patch Changes

- Updated dependencies [7b92dc8]
  - @onesub/shared@0.5.0
  - @onesub/server@0.9.0

## 0.1.7

### Patch Changes

- Updated dependencies [fb1af23]
  - @onesub/shared@0.4.0
  - @onesub/server@0.8.0

## 0.1.6

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
  - @onesub/server@0.7.3

## 0.1.5

### Patch Changes

- Updated dependencies [63580dc]
  - @onesub/shared@0.3.4

## 0.1.4

### Patch Changes

- Updated dependencies [636ce9f]
  - @onesub/shared@0.3.3

## 0.1.3

### Patch Changes

- d4db651: Fix: scaffolded projects missing `.gitignore`.

  npm publish strips `.gitignore` files from published tarballs, so `templates/.gitignore` never shipped and `onesub init` crashed with `ENOENT` at the last step. Template file renamed to `templates/_gitignore` and `copyTemplate` now supports a destination rename — the scaffolded project gets a real `.gitignore` again.

## 0.1.2

### Patch Changes

- df8dbf0: `@onesub/server`: `express`를 `peerDependencies`로 이동 (`"^4.17.0 || ^5.0.0"`).

  Middleware 라이브러리의 표준 패턴 — 호스트 앱이 가진 express 인스턴스를 그대로 사용하므로 이중 설치 / Router 인스턴스 mismatch 문제가 사라집니다. Express 4와 5 모두 지원.

  설치 시 호스트 앱에 `express`를 명시적으로 두세요:

  ```bash
  npm install @onesub/server express
  ```

  자세한 마이그레이션은 [`docs/MIGRATION.md`](https://github.com/jeonghwanko/onesub/blob/master/docs/MIGRATION.md)의 `0.6.x → 0.7.0` 섹션 참조.

  `@onesub/cli`: 생성 템플릿의 `@onesub/server` 버전 핀을 `^0.7.0`으로 갱신.

## 0.1.1

### Patch Changes

- a62f241: OSS readiness pass: pluggable logger (`OneSubServerConfig.logger` / `setLogger`), canonical Postgres `sql/schema.sql` with runtime parity test, webhook retry semantics documented (4xx vs 5xx), per-package READMEs for npm, new `@onesub/cli` scaffolding package (`npx @onesub/cli init`), Apple Root CA G3 bundle protected by unit tests.

  No API breakage — all additions are backward compatible.

- Updated dependencies [a62f241]
  - @onesub/shared@0.3.2
