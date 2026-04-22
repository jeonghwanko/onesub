---
'@onesub/shared': patch
'@onesub/server': patch
'@onesub/cli': patch
---

오픈소스 채택의 진입장벽을 낮추기 위한 2단계 작업 + 보안/버그 fix.

**@onesub/shared**:
- `MOCK_RECEIPT_PREFIX` 상수 export — 테스트 시나리오별 prefix (REVOKED / EXPIRED / INVALID / BAD_SIG / NETWORK_ERROR / SANDBOX)
- `OneSubServerConfig.apple.mockMode` + `.google.mockMode` 필드 추가

**@onesub/server**:
- 신규 `providers/mock.ts` — Apple/Google API 없이 동작하는 mock 구현. receipt 문자열 prefix로 시나리오 결정, `sha256(receipt)` 기반 결정적 transactionId
- `validateAppleReceipt` / `validateAppleConsumableReceipt` / `validateGoogleReceipt` / `validateGoogleProductReceipt`가 `config.*.mockMode` 체크 후 mock으로 분기
- **보안 가드**: `NODE_ENV=production` + `mockMode: true` 조합 시 `createOneSubMiddleware`가 hard throw. mockMode는 임의 영수증을 valid로 받아서 프로덕션에서 실수로 켜지면 사기 피해
- **버그 fix**: Admin auth 미들웨어가 호스트 앱의 모든 라우트(예: `/health`)를 401로 가로채던 오래된 버그. `router.use(authMw)` → `router.use('/onesub/purchase/admin', authMw)` 로 path-scoped. 회귀 테스트 추가
- `GoogleProductResult` mock 파라미터명 `purchaseToken` → `receipt`로 real provider와 통일

**@onesub/cli**:
- 신규 `onesub dev [--port N]` 서브커맨드 — in-memory 스토어 + 양쪽 mockMode의 onesub 서버를 1줄로 기동. Apple/Google 자격증명 없이 `POST /onesub/validate` / `POST /onesub/purchase/validate` / 웹훅까지 전 플로우 로컬 검증 가능
- 127.0.0.1로만 bind (ngrok/포트포워드 실수로 dev-admin-secret 노출 방지)
- `@onesub/server` + `express` runtime dep 추가 (dev 명령만 사용, lazy import로 init 명령 실행 시에는 로드 안 함)

**사용 예**:
```bash
npx @onesub/cli dev
# → http://localhost:4100 — Apple/Google 없이 바로 curl 테스트 가능
curl -X POST http://localhost:4100/onesub/purchase/validate \
  -H "Content-Type: application/json" \
  -d '{"platform":"apple","receipt":"MOCK_VALID_x","userId":"u1","productId":"prem","type":"non_consumable"}'
# → { "valid": true, "action": "new", ... }

# 에러 시나리오 재현
-d '{"...","receipt":"MOCK_REVOKED_x", ...}'
# → 422 { "errorCode": "RECEIPT_VALIDATION_FAILED" }
```

tests: 140 → 165 (+25 신규 — classifyMockReceipt 8 cases / mock validators 11 cases / HTTP integration 5 cases / prod guard 1 case / admin middleware scope regression 1 case).
