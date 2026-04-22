---
'@onesub/shared': patch
'@jeonghwanko/onesub-sdk': patch
---

Debug 모드 추가. `config.debug: true`로 SDK의 구매/복원 lifecycle 전 구간에서 `[onesub]` prefix 붙은 trace 로그가 자동 출력 — integration 진단 시간 단축 목적.

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
