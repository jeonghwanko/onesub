---
"@onesub/shared": minor
"@onesub/server": minor
---

운영 안정성 보강 (Apple JWT 캐시, fetch timeout) + paused 메타데이터(autoResumeTime)

### Apple App Store Server API 안정성

- **JWT 캐시**: `makeAppleApiJwt`에 모듈 레벨 캐시 + Promise dedup (Google `getCachedAccessToken`과 동일 패턴). 20분 TTL, 만료 60초 전부터 refresh. 동시 burst에서도 단일 ECDSA-sign.
  - 이전엔 매 호출마다 sign — webhook 폭주(unknown-tx fallback이 Status API 호출하는 경우 등) 시 CPU 낭비.

### Outbound fetch timeout

- **`http.ts/fetchWithTimeout`** — 모든 outbound 호출에 AbortController 기반 timeout (default 10s) + caller signal 합성 + timer 자동 cleanup
- 적용: Apple Status API / Consumption Response, Google subscriptionsv2 / products / OAuth / acknowledge×2 / consume (총 8 sites)
- 이전엔 Node global `fetch`가 default timeout 없어 upstream hang 시 webhook도 hang → request pile-up.

### Google paused — autoResumeTime 메타데이터

- **`SubscriptionInfo.autoResumeTime?: string`** 추가 (Google 전용 옵션 RFC3339)
- `validateGoogleReceipt`가 `status === 'paused'`일 때만 v2 응답의 `pausedStateContext.autoResumeTime` 추출 (defensive — 다른 상태에 잘못 붙어 와도 무시)
- 호스트 앱이 단순 "일시정지 중" 대신 "재개 예정: YYYY-MM-DD" UX 표시 가능

### Postgres

- `onesub_subscriptions.auto_resume_time TIMESTAMPTZ` 칼럼 추가
- `ALTER TABLE IF NOT EXISTS`로 기존 설치 자동 backfill

### 인프라 / 위생

- `.gitattributes` 추가 — `*.ts`/`*.sql`/`*.md` 등 text 소스를 LF로 강제. Windows `core.autocrlf` 환경에서 schema parity test가 silently fail하던 문제 영구 fix
- `schema.test.ts` `normalize` 함수에 `\r` 제거 — 위와 동일 cross-platform 안전망

### 동작 변경

없음. 모두 additive 또는 internal hardening.
