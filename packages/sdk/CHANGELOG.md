# @jeonghwanko/onesub-sdk

## 0.6.5

### Patch Changes

- Updated dependencies [b7afee1]
  - @onesub/shared@0.7.4

## 0.6.4

### Patch Changes

- Updated dependencies [f4ef21f]
  - @onesub/shared@0.7.3

## 0.6.3

### Patch Changes

- Updated dependencies [bc1c343]
  - @onesub/shared@0.7.2

## 0.6.2

### Patch Changes

- Updated dependencies [8345e13]
  - @onesub/shared@0.7.1

## 0.6.1

### Patch Changes

- Updated dependencies [05ac535]
  - @onesub/shared@0.7.0

## 0.6.0

### Minor Changes

- 10c5d0a: Entitlements 추상화 — 호스트 앱이 productId 대신 안정적인 entitlement 이름(`'premium'`)으로 권한 체크. productId 변경/promo SKU 추가/마이그레이션이 호스트 코드에 영향 안 줌. RevenueCat의 핵심 추상화를 OSS로.

  ### Server

  - 새 config: `OneSubServerConfig.entitlements: { premium: { productIds: [...] } }`
  - 새 endpoint:
    - `GET /onesub/entitlement?userId=&id=premium` — 단일 체크
    - `GET /onesub/entitlements?userId=` — 모든 entitlement bulk
  - 평가 로직: 활성 subscription(`active`|`grace_period` AND `expiresAt > now`) 또는 non-consumable purchase가 entitlement의 productIds 중 하나와 매칭되면 entitled. consumable은 제외 (one-time resource, ongoing right 아님)
  - `evaluateEntitlement(userId, entitlement, store, purchaseStore)` export — 호스트가 background worker / 커스텀 라우트에서 in-process 평가 가능
  - `SubscriptionStore.getAllByUserId(userId)` 신규 — 한 user의 multi-product 구독 list
  - `InMemorySubscriptionStore`가 user당 multi-record 보관 (이전 single coalesce). `getByUserId`는 latest 단일 반환 contract 호환

  ### Shared

  새 타입: `Entitlement`, `EntitlementsConfig`, `EntitlementStatus`, `EntitlementResponse`, `EntitlementsResponse`
  새 routes: `ROUTES.ENTITLEMENT`, `ROUTES.ENTITLEMENTS`
  새 error codes: `ENTITLEMENT_NOT_FOUND`, `ENTITLEMENTS_NOT_CONFIGURED`

  ### SDK

  - `useOneSub().hasEntitlement(id): boolean`
  - `useOneSub().entitlements: Record<string, EntitlementStatus>`
  - `useOneSub().refreshEntitlements(): Promise<void>`
  - `OneSubProvider`가 mount 시 자동 fetch + `subscribe`/`restore`/`purchaseProduct`/`restoreProduct` 후 자동 refresh
  - API helpers: `checkEntitlement`, `checkEntitlements`
  - 404 (서버에 entitlements 미설정) → 빈 map (throw 안 함)

  ### 사용 예

  ```ts
  // 서버
  app.use(createOneSubMiddleware({
    ...,
    entitlements: {
      premium: { productIds: ['pro_monthly', 'pro_yearly', 'lifetime_pass'] },
      promode: { productIds: ['dev_tools_addon'] },
    },
  }));

  // 클라이언트
  const { hasEntitlement, entitlements } = useOneSub();
  if (hasEntitlement('premium')) {
    // entitled — productId 신경 안 써도 됨
  }
  ```

  ### Breaking changes

  없음. 모두 additive:

  - config 옵션, endpoint, type, store 메서드 모두 신규
  - 기존 `useOneSub` 호출자 무영향 (return shape 추가만)
  - entitlements 설정 안 한 서버는 라우터 미마운트 (이전 동작 그대로)

### Patch Changes

- Updated dependencies [10c5d0a]
  - @onesub/shared@0.6.0

## 0.5.6

### Patch Changes

- Updated dependencies [7b92dc8]
  - @onesub/shared@0.5.0

## 0.5.5

### Patch Changes

- Updated dependencies [fb1af23]
  - @onesub/shared@0.4.0

## 0.5.4

### Patch Changes

- Updated dependencies [35b7ca1]
  - @onesub/shared@0.3.5

## 0.5.3

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

- Updated dependencies [63580dc]
  - @onesub/shared@0.3.4

## 0.5.2

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

## 0.5.1

### Patch Changes

- 1d38d6d: Fix: 0.5.0의 mount-level listener + in-flight ref-map 아키텍처에 남아 있던 race condition 해소.

  **발견한 문제:** 사용자가 앱 mount 직후 `subscribe()` / `purchaseProduct()`를 탭하면 in-flight entry가 등록된 상태에서 StoreKit이 queued된 replay를 뒤늦게 delivery — listener가 in-flight 매칭을 찾아 resolve해버려 "시트 없이 복구됨" 버그가 재현됨.

  **해결:** mount 후 2.5초 drain window 동안 `allowInFlightMatching()`이 false를 반환하도록 gate 추가. drain 중에는 listener가 in-flight를 보더라도 무시하고 orphan silent 경로로 처리 — in-flight entry는 보존. `subscribe()` / `purchaseProduct()`는 내부적으로 drain 완료를 await한 뒤에 `requestPurchase`를 호출. 따라서 StoreKit이 새로 만드는 transaction만이 fresh event로 매칭됨.

  **검증:** `purchaseFlow.test.ts`에 드레인-윈도우 race 재현 테스트 2건 추가. 이전 4번의 추측 수정과 달리 이번엔 실제 race를 unit 테스트로 증명.

## 0.5.0

### Minor Changes

- 839909a: Rewrite: mount 시 단일 purchaseUpdatedListener + in-flight ref map 아키텍처.

  **왜 필요했는가.** 0.4.2~0.4.5가 전부 "per-call 리스너" 패턴이었음 — `purchaseProduct`가 호출될 때마다 `purchaseUpdatedListener`를 attach → `requestPurchase` 호출 → 받은 첫 이벤트를 "이번 결제 결과"로 취급. 이 패턴은 StoreKit 2의 `Transaction.updates` 설계와 맞지 않음.

  Apple 공식 문서 ([transaction/updates](https://developer.apple.com/documentation/storekit/transaction/updates))대로, `Transaction.updates`는 **리스너 attach 시점에 unfinished transaction을 replay**함 — 사용자 인증 시트 없이. 이전 세션에서 `finishTransaction`이 누락된 거래(TestFlight 테스트, 크래시, force-quit 등)가 있으면 리스너가 attach되자마자 그 replay가 fresh event처럼 들어와서 `requestPurchase`의 StoreKit 시트가 뜨기도 전에 "결제 완료"로 처리됨.

  0.4.3 (transactionDate 필터) / 0.4.4 (transactionId snapshot) / 0.4.5 (pending flush)는 모두 이 replay를 client에서 필터링/우회하려 했으나 iOS 샌드박스의 불확정적 동작과 싸우는 접근이어서 완결되지 않음.

  **무엇이 바뀌었는가.**

  1. **Provider mount 시 한 번만** `purchaseUpdatedListener` + `purchaseErrorListener` attach (이전: `subscribe`/`purchaseProduct` 호출마다 attach). unmount 시 정리.
  2. 리스너는 모든 이벤트(replay 포함)를 서버에 validate → 성공 시 `finishTransaction`. 서버의 idempotent 응답(`action: 'new' | 'restored'`)이 신규/복원을 식별. 실패 시 finish 하지 않아 다음 launch에 자연 replay (at-least-once semantics — RevenueCat / Qonversion 패턴).
  3. `subscribe()` / `purchaseProduct()`는 in-flight 약속을 `productId` 키로 ref map에 등록 후 `requestPurchase` 호출. 리스너가 매칭 이벤트 받을 때 resolve.
  4. **in-flight 없는 "orphan" 이벤트**(앱 시작 직후 replay)는 리스너가 silently 처리 — state만 업데이트하고 UI 부작용 없음. `purchase.productType` 필드로 subscription vs one-time 구분.

  **효과.** 사용자가 `subscribe`/`purchaseProduct`를 호출하는 시점에는 이미 queue가 drain된 상태이므로, StoreKit이 만들어낼 수 있는 이벤트는 **오직 사용자 인증 시트 통과 후 생성된 fresh transaction**뿐. 이전의 4차례 필터/flush 로직은 모두 제거.

  **호환성.** 외부 API(`subscribe`, `restore`, `purchaseProduct`, `restoreProduct`, return shape) 완전 동일. 앱 코드 변경 불필요.

## 0.4.5

### Patch Changes

- 8e5179a: Fix: 0.4.3 / 0.4.4 모두 StoreKit 큐의 stale transaction 처리를 "필터링"으로 접근했지만 iOS 샌드박스의 실제 동작과 일치하지 않아 결제가 "처리중"에서 멈추는 현상이 남아 있었습니다.

  0.4.5는 **필터가 아니라 flush**로 전환: `requestPurchase` 호출 **직전에** 해당 `productId`의 pending 거래를 `finishTransaction`으로 큐에서 먼저 비워냅니다. 이후 listener를 attach하면 이벤트가 발생할 수 있는 경우는 오직 새 `requestPurchase`가 만들어내는 신규 거래뿐 — 인증 시트가 반드시 먼저 떠야 이벤트가 생깁니다.

  pending이 없는 유저는 flush가 no-op. 기존 pending이 진짜로 유효한 경우엔 서버의 `action: 'restored'` 경로가 다음번 정상 결제 또는 `restoreProduct` 호출 시 복구해줍니다.

## 0.4.4

### Patch Changes

- c247aa3: Fix: 0.4.3의 `transactionDate` 기반 필터가 iOS 실제 필드 포맷과 맞지 않아 **fresh 이벤트까지 차단**되어 결제가 "처리중"에서 멈추던 문제.

  `transactionId` 기반 필터로 교체 — `requestPurchase` 직전에 `getAvailablePurchases()`로 기존 pending 거래의 `transactionId`를 스냅샷하고, listener는 그 집합에 없는 `transactionId`만 신규로 수락. 타임스탬프 포맷 / 클럭 스큐 / 샌드박스 날짜 이슈에 무관하게 작동.

  이전 세션의 stale pending은 여전히 silent finish로 큐에서 정리됨. pending이 없는 유저(대부분)는 스냅샷이 빈 집합이라 필터가 no-op — 0.4.2 이전 동작과 동일.

## 0.4.3

### Patch Changes

- f5fb402: Fix: TestFlight / 재설치 후 결제 시 **StoreKit 인증 시트 없이** "결제가 복구되었습니다" 메시지만 뜨는 문제.

  StoreKit 큐에 이전 세션의 `finishTransaction` 안 된 거래가 남아 있으면, `initConnection()` 연결 직후 `purchaseUpdatedListener`가 **확인 시트 없이** 즉시 해당 이벤트로 실행됩니다. SDK가 이를 현재 `requestPurchase`의 결과로 오인해 서버에 재검증을 보내고, 서버는 0.6.2+에서 추가된 `action: 'restored'` 응답을 돌려줘 앱이 "복원" UX를 띄웁니다.

  해결: `awaitPurchaseEvent`에 `startedAt` 타임스탬프를 전달해 `transactionDate`가 그보다 명백히 이전(10초 이상)인 이벤트는 무시 + 큐에서 silent finish. `requestPurchase`가 트리거한 fresh 거래만 수락.

  `subscribe`와 `purchaseProduct` 양쪽 모두 적용.

## 0.4.2

### Patch Changes

- a62f241: OSS readiness pass: pluggable logger (`OneSubServerConfig.logger` / `setLogger`), canonical Postgres `sql/schema.sql` with runtime parity test, webhook retry semantics documented (4xx vs 5xx), per-package READMEs for npm, new `@onesub/cli` scaffolding package (`npx @onesub/cli init`), Apple Root CA G3 bundle protected by unit tests.

  No API breakage — all additions are backward compatible.

- Updated dependencies [a62f241]
  - @onesub/shared@0.3.2
