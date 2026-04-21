# @jeonghwanko/onesub-sdk

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
