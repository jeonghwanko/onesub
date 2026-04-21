---
'@jeonghwanko/onesub-sdk': patch
---

Fix: 0.5.0의 mount-level listener + in-flight ref-map 아키텍처에 남아 있던 race condition 해소.

**발견한 문제:** 사용자가 앱 mount 직후 `subscribe()` / `purchaseProduct()`를 탭하면 in-flight entry가 등록된 상태에서 StoreKit이 queued된 replay를 뒤늦게 delivery — listener가 in-flight 매칭을 찾아 resolve해버려 "시트 없이 복구됨" 버그가 재현됨.

**해결:** mount 후 2.5초 drain window 동안 `allowInFlightMatching()`이 false를 반환하도록 gate 추가. drain 중에는 listener가 in-flight를 보더라도 무시하고 orphan silent 경로로 처리 — in-flight entry는 보존. `subscribe()` / `purchaseProduct()`는 내부적으로 drain 완료를 await한 뒤에 `requestPurchase`를 호출. 따라서 StoreKit이 새로 만드는 transaction만이 fresh event로 매칭됨.

**검증:** `purchaseFlow.test.ts`에 드레인-윈도우 race 재현 테스트 2건 추가. 이전 4번의 추측 수정과 달리 이번엔 실제 race를 unit 테스트로 증명.
