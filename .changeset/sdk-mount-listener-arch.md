---
'@jeonghwanko/onesub-sdk': minor
---

Rewrite: mount 시 단일 purchaseUpdatedListener + in-flight ref map 아키텍처.

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
