---
'@jeonghwanko/onesub-sdk': patch
---

Fix: 0.4.3의 `transactionDate` 기반 필터가 iOS 실제 필드 포맷과 맞지 않아 **fresh 이벤트까지 차단**되어 결제가 "처리중"에서 멈추던 문제.

`transactionId` 기반 필터로 교체 — `requestPurchase` 직전에 `getAvailablePurchases()`로 기존 pending 거래의 `transactionId`를 스냅샷하고, listener는 그 집합에 없는 `transactionId`만 신규로 수락. 타임스탬프 포맷 / 클럭 스큐 / 샌드박스 날짜 이슈에 무관하게 작동.

이전 세션의 stale pending은 여전히 silent finish로 큐에서 정리됨. pending이 없는 유저(대부분)는 스냅샷이 빈 집합이라 필터가 no-op — 0.4.2 이전 동작과 동일.
