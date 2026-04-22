# @onesub/shared

## 0.3.4

### Patch Changes

- 63580dc: Debug 모드 추가. `config.debug: true`로 SDK의 구매/복원 lifecycle 전 구간에서 `[onesub]` prefix 붙은 trace 로그가 자동 출력 — integration 진단 시간 단축 목적.

  **@onesub/shared**: `OneSubConfig`에 `debug?: boolean` + `logger?: OneSubLogger` 추가. `logger` 생략 시 `console` 사용.

  **@jeonghwanko/onesub-sdk**: 새 `createSdkLogger(config)` 헬퍼가 `{ trace, info, warn, error }` sink를 만들어 Provider + `handlePurchaseEvent`에 주입. `trace`는 `debug === true`일 때만 활성화(그 외엔 no-op). 기록 지점:

  - Provider mount / unmount (serverUrl, userId, mockMode, pending in-flight count)
  - IAP `initConnection` 시작/성공/실패
  - Listener attach, drain window 열림/닫힘 (원인 포함)
  - 각 `purchaseUpdatedListener` 이벤트: productId, transactionId, productType, hasInFlight, matchingAllowed, matched
  - 서버 validate 요청/결과 (valid, action, errorCode)
  - finishTransaction 호출, reject/resolve 결과
  - `subscribe()` / `purchaseProduct()` 진입 (drainReady 상태 포함)
  - `purchaseErrorListener` 이벤트 (RN-IAP code → OneSubErrorCode 매핑)

  **사용법**:

  ```tsx
  <OneSubProvider
    config={{ serverUrl, productId, debug: __DEV__ }}
    userId={userId}
  >
    <App />
  </OneSubProvider>
  ```

  샘플 출력:

  ```
  [onesub] provider mount { serverUrl: ..., userId: 'user_1', mockMode: false }
  [onesub] initConnection ok
  [onesub] listeners attached; drain window open { drainMs: 2500 }
  [onesub] drain released { reason: 'timeout', waiters: 0 }
  [onesub] subscribe() called { productId: 'pro_monthly', drainReady: true }
  [onesub] event received { productId: 'pro_monthly', transactionId: 'tx_42', matched: true }
  [onesub] subscription validated { productId: 'pro_monthly', action: 'new' }
  ```

  프로덕션에선 `debug`를 false/omit 하면 trace 경로는 JS 엔진 dead code로 무부담.

  커스텀 logger 사용 예 (`pino` 등):

  ```tsx
  <OneSubProvider config={{ ..., logger: pinoInstance, debug: true }} ... />
  ```

  테스트 8 cases 추가 (logger 5 + purchaseFlow logger 3).

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
