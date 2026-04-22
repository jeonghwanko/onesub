# @onesub/shared

## 0.3.3

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

## 0.3.2

### Patch Changes

- a62f241: OSS readiness pass: pluggable logger (`OneSubServerConfig.logger` / `setLogger`), canonical Postgres `sql/schema.sql` with runtime parity test, webhook retry semantics documented (4xx vs 5xx), per-package READMEs for npm, new `@onesub/cli` scaffolding package (`npx @onesub/cli init`), Apple Root CA G3 bundle protected by unit tests.

  No API breakage — all additions are backward compatible.
