# @jeonghwanko/onesub-sdk

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
