---
"@onesub/shared": minor
"@onesub/server": minor
---

Read API for metrics — count-based aggregation endpoints. 운영자/PM이 호스트 dashboard 없이도 핵심 metrics 조회 가능. raw API → Grafana / Metabase로 시각화.

### Endpoints

모두 `X-Admin-Secret` 헤더 필수. `config.adminSecret` 미설정 시 라우터 미마운트.

- `GET /onesub/metrics/active` — 현시점 entitled 수 (active+grace_period sub + non-consumable purchase). consumable 제외. `byProduct` / `byPlatform` 그룹.
- `GET /onesub/metrics/started?from=&to=` — `purchasedAt` 기간 내 신규 sub 수 + 그룹.
- `GET /onesub/metrics/expired?from=&to=` — `expiresAt` 기간 내 + status가 expired/canceled인 sub만 (status=active는 갱신 가능이라 제외).

### 평가 정책 (status route와 일관)

- `activeSubscriptions` = `status ∈ {active, grace_period} AND expiresAt > now`
- `gracePeriodSubscriptions` = 위의 grace_period subset (at-risk cohort)
- `nonConsumablePurchases` = type=non_consumable purchase 수 (consumable은 entitlement 평가와 동일하게 제외)

### Store API

- `SubscriptionStore.listAll()`, `PurchaseStore.listAll()` 추가 — InMemory iterate, Postgres `SELECT *`
- list-then-aggregate 전략. ~100k records까지 OK. 큰 deployment는 SQL aggregate 별개 PR로 최적화

### Shared

- 새 타입: `MetricsActiveResponse`, `MetricsCountResponse`
- 새 routes: `ROUTES.METRICS_ACTIVE`, `METRICS_STARTED`, `METRICS_EXPIRED`

### Future work (별개 PR)

- 매출 metrics (MRR/LTV) — `config.products: { 'pro_monthly': { price: 9.99, currency: 'USD' } }` 매핑 추가 필요
- SQL aggregate 최적화 (큰 deployment용)
- Time-series snapshot (cron으로 hourly/daily 저장 → 시점별 과거 query)

### Breaking changes

없음. 모두 additive:
- 라우터는 `adminSecret` 명시될 때만 mount (이전 동작 그대로)
- Store interface 확장 (`listAll`) — 새 메서드 추가, 기존 contract 보존
- 기존 호출자 무영향
