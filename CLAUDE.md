# onesub — AI 작업 가이드

## 프로젝트 개요

월 구독 + 페이월. 그게 끝. MCP 기반 AI-네이티브 모바일 구독 서비스.

## 모노레포 구조

```
onesub/
├── packages/shared/       # @onesub/shared — 공유 타입/상수
├── packages/server/       # @onesub/server — Express 미들웨어 (영수증 검증 + Webhook)
├── packages/sdk/          # onesub — React Native SDK (useOneSub + Paywall)
└── packages/mcp-server/   # @onesub/mcp-server — MCP 도구 (AI 통합)
```

## 기술 스택

- **언어**: TypeScript 5.7, ESM (NodeNext)
- **서버**: Express.js 미들웨어 패턴
- **SDK**: React Native + react-native-iap
- **MCP**: @modelcontextprotocol/sdk (stdio transport)
- **영수증 검증**: Apple StoreKit 2 JWS + Google Play Developer API v3

## 핵심 철학

1. **단순함**: 월 구독 하나 + 페이월 하나. 그 이상 없음
2. **오픈소스**: MIT 라이센스, 셀프호스트 가능
3. **AI 퍼스트**: MCP 도구로 "구독 달아줘" 한 마디면 끝
4. **플러그형**: Express 미들웨어로 기존 서버에 `app.use()` 한 줄

## 개발 명령어

```bash
npm install              # 전체 의존성
npm run build            # 전체 빌드
npm run type-check       # 타입 체크
```

## 패키지별 역할

### @onesub/shared
공유 타입과 상수. 다른 패키지에서 import.

### @onesub/server
Express 미들웨어. 두 가지 사용법:
```ts
// 1. 기존 서버에 마운트
app.use(createOneSubMiddleware(config));

// 2. 독립 실행
createOneSubServer(config).listen(4100);
```

### onesub (SDK)
React Native 앱에서 사용:
```tsx
<OneSubProvider config={config} userId={userId}>
  <App />
</OneSubProvider>

// 컴포넌트에서
const { isActive, subscribe } = useOneSub();
```

### @onesub/mcp-server
AI 도구 4개:
- `onesub_setup` — 프로젝트 분석 + 통합 코드 생성
- `onesub_add_paywall` — 페이월 화면 생성
- `onesub_check_status` — 구독 상태 확인
- `onesub_troubleshoot` — IAP 문제 진단

## 코딩 규칙

- `.js` 확장자 필수 (ESM imports)
- shared 타입은 `@onesub/shared`에서만 정의
- 서버 저장소는 `SubscriptionStore` 인터페이스 (기본: in-memory, 교체 가능)
- SDK는 react-native-iap를 optional peer dep으로 사용
