---
"@onesub/shared": minor
"@onesub/server": minor
"@jeonghwanko/onesub-sdk": minor
---

Entitlements 추상화 — 호스트 앱이 productId 대신 안정적인 entitlement 이름(`'premium'`)으로 권한 체크. productId 변경/promo SKU 추가/마이그레이션이 호스트 코드에 영향 안 줌. RevenueCat의 핵심 추상화를 OSS로.

### Server

- 새 config: `OneSubServerConfig.entitlements: { premium: { productIds: [...] } }`
- 새 endpoint:
  - `GET /onesub/entitlement?userId=&id=premium` — 단일 체크
  - `GET /onesub/entitlements?userId=` — 모든 entitlement bulk
- 평가 로직: 활성 subscription(`active`|`grace_period` AND `expiresAt > now`) 또는 non-consumable purchase가 entitlement의 productIds 중 하나와 매칭되면 entitled. consumable은 제외 (one-time resource, ongoing right 아님)
- `evaluateEntitlement(userId, entitlement, store, purchaseStore)` export — 호스트가 background worker / 커스텀 라우트에서 in-process 평가 가능
- `SubscriptionStore.getAllByUserId(userId)` 신규 — 한 user의 multi-product 구독 list
- `InMemorySubscriptionStore`가 user당 multi-record 보관 (이전 single coalesce). `getByUserId`는 latest 단일 반환 contract 호환

### Shared

새 타입: `Entitlement`, `EntitlementsConfig`, `EntitlementStatus`, `EntitlementResponse`, `EntitlementsResponse`
새 routes: `ROUTES.ENTITLEMENT`, `ROUTES.ENTITLEMENTS`
새 error codes: `ENTITLEMENT_NOT_FOUND`, `ENTITLEMENTS_NOT_CONFIGURED`

### SDK

- `useOneSub().hasEntitlement(id): boolean`
- `useOneSub().entitlements: Record<string, EntitlementStatus>`
- `useOneSub().refreshEntitlements(): Promise<void>`
- `OneSubProvider`가 mount 시 자동 fetch + `subscribe`/`restore`/`purchaseProduct`/`restoreProduct` 후 자동 refresh
- API helpers: `checkEntitlement`, `checkEntitlements`
- 404 (서버에 entitlements 미설정) → 빈 map (throw 안 함)

### 사용 예

```ts
// 서버
app.use(createOneSubMiddleware({
  ...,
  entitlements: {
    premium: { productIds: ['pro_monthly', 'pro_yearly', 'lifetime_pass'] },
    promode: { productIds: ['dev_tools_addon'] },
  },
}));

// 클라이언트
const { hasEntitlement, entitlements } = useOneSub();
if (hasEntitlement('premium')) {
  // entitled — productId 신경 안 써도 됨
}
```

### Breaking changes

없음. 모두 additive:
- config 옵션, endpoint, type, store 메서드 모두 신규
- 기존 `useOneSub` 호출자 무영향 (return shape 추가만)
- entitlements 설정 안 한 서버는 라우터 미마운트 (이전 동작 그대로)
