---
"@onesub/shared": minor
"@onesub/server": minor
---

구독/IAP 라이프사이클 보강 — 새 상태(grace_period/on_hold/paused), 환불 정책, Google v2 API 마이그레이션, Apple Subscription Status API 직접 조회

### Apple

- **App Store Server API 직접 조회** (`fetchAppleSubscriptionStatus`) — webhook 유실/순서 꼬임 시 복구. webhook의 unknown-transaction 분기에서도 자동 fallback fetch
- **`BILLING_RETRY` / `GRACE_PERIOD_EXPIRED` 매핑** — `DID_FAIL_TO_RENEW` (subtype 분기), `GRACE_PERIOD_EXPIRED` 정확히 처리
- **`CONSUMPTION_REQUEST` 응답 API** — `apple.consumptionInfoProvider` hook으로 환불 결정에 사용량 정보 제공
- **IAP `REFUND` 처리** — `PurchaseStore.deletePurchaseByTransactionId`로 정확한 단일 row 삭제 (구독 환불과 분리)
- **`type`/`environment`/`bundleId`/`transactionId` 노출** — `decodeAppleNotification` 반환 확장

### Google

- **Play Developer API v1 → v2 마이그레이션** (`subscriptionsv2.get`) — `subscriptionState` enum 직접 매핑으로 grace_period/on_hold/paused 정확히 잡음 (이전 v1은 expiry/cancelReason 추정)
- **`acknowledgePurchase` 자동 호출** (구독 + non-consumable IAP) — 미호출 시 3일 내 자동 환불 위험 해결
- **`voidedPurchasesNotification` 핸들러** — productType=1(구독)은 status 변경, productType=2(IAP)는 row 삭제
- **`SUBSCRIPTION_PAUSED` (10) → 새 `paused` 상태** — 사용자 의지 일시정지, `on_hold`(결제 실패)와 구분
- **`SUBSCRIPTION_PRICE_CHANGE_CONFIRMED` (8)** + `google.onPriceChangeConfirmed` hook
- **`linkedPurchaseToken` 체인 추적** — 업그레이드/다운그레이드 시 이전 record의 userId 자동 인계 (continuity)

### 라이프사이클 상태 확장

`SubscriptionStatus`에 추가:
- `grace_period`: 결제 실패지만 store가 entitlement 유지 — `active`로 분류 (status route)
- `on_hold`: grace 끝, retry 중 — entitlement 회수
- `paused`: 사용자 의지 일시정지 (Google) — entitlement 회수, UX는 `on_hold`와 별개

> **호환성**: 호스트 앱이 `switch (status)` exhaustive로 다루면 새 case 추가 필요. string 비교만 하면 무영향.

### 환불 정책

`OneSubServerConfig.refundPolicy?: 'immediate' | 'until_expiry'` (default `'immediate'`):
- 구독 환불 시 즉시 status=canceled (default) vs 만료까지 entitlement 유지
- IAP는 정책 무관 — 항상 즉시 삭제 (만료 개념 없음)

### Status route 안전망

`active` 판정에 `expiresAt > now` 체크 추가 — `until_expiry` 모드 자연 만료 + EXPIRED webhook 유실 대비 stale-record backstop.

### Postgres

`onesub_subscriptions.linked_purchase_token TEXT` 칼럼 추가. `ALTER TABLE IF NOT EXISTS`로 기존 설치 자동 backfill.

### 동작 변경 (worth noting)

- `validateGoogleReceipt`가 PAUSED 상태를 `'paused'` 반환 (이전 `'on_hold'`)
- Google webhook의 grace_period 알림이 `grace_period` 상태로 정확히 분류 (이전엔 잘못 `active`로)
- Google webhook의 on_hold 알림이 `on_hold` 상태로 정확히 분류 (이전엔 무처리)
- Apple/Google 구독 환불 알림 시 `status='canceled'` (이전 동작 유지) — `refundPolicy='until_expiry'`로 옵트인 변경 가능
