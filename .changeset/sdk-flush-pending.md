---
'@jeonghwanko/onesub-sdk': patch
---

Fix: 0.4.3 / 0.4.4 모두 StoreKit 큐의 stale transaction 처리를 "필터링"으로 접근했지만 iOS 샌드박스의 실제 동작과 일치하지 않아 결제가 "처리중"에서 멈추는 현상이 남아 있었습니다.

0.4.5는 **필터가 아니라 flush**로 전환: `requestPurchase` 호출 **직전에** 해당 `productId`의 pending 거래를 `finishTransaction`으로 큐에서 먼저 비워냅니다. 이후 listener를 attach하면 이벤트가 발생할 수 있는 경우는 오직 새 `requestPurchase`가 만들어내는 신규 거래뿐 — 인증 시트가 반드시 먼저 떠야 이벤트가 생깁니다.

pending이 없는 유저는 flush가 no-op. 기존 pending이 진짜로 유효한 경우엔 서버의 `action: 'restored'` 경로가 다음번 정상 결제 또는 `restoreProduct` 호출 시 복구해줍니다.
