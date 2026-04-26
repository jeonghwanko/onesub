---
"@onesub/server": patch
---

fix(webhook): Google fresh re-fetch 후 store update 시 `autoResumeTime` / `linkedPurchaseToken` propagation 누락

PR #31 (linkedPurchaseToken)과 PR #35 (autoResumeTime)에서 `SubscriptionInfo`에 새 필드를 추가했지만, Google webhook의 fresh re-fetch 후 store update path에서 `status`/`expiresAt`/`willRenew`만 propagate하고 두 신규 필드는 누락됐었음. 단위 테스트는 1개 알림만 검증해서 못 잡았고, PR #38에 추가된 시퀀스 시나리오 테스트가 발견.

결과 (이전 0.9.0 동작):
- `paused → active` 복귀 시 stale `autoResumeTime`이 store에 남아있음
- plan 변경 chain에서 `linkedPurchaseToken`이 후속 알림에 의해 사라질 수 있음

Fix: webhook의 Google update 분기에서 두 필드 propagate. `linkedPurchaseToken`은 fresh가 항상 보내지 않을 수 있으므로 `?? existing` fallback으로 chain history 보존.
