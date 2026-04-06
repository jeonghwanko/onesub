<p align="center">
  <img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License" />
  <img src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg" alt="PRs Welcome" />
  <img src="https://img.shields.io/badge/platform-iOS%20%7C%20Android-lightgrey.svg" alt="Platform" />
</p>

<h1 align="center">onesub</h1>

<p align="center">
  <strong>One subscription. That's it.</strong><br/>
  월 구독 하나. 페이월 하나. 끝.
</p>

<p align="center">
  AI-native monthly subscription + paywall for mobile apps.<br/>
  Open source. Dead simple. MCP-powered.
</p>

---

```tsx
import { OneSubProvider, useOneSub, Paywall } from 'onesub';

const { isActive, subscribe } = useOneSub();

if (!isActive) return <Paywall config={config} onSubscribe={subscribe} />;
```

---

## Why onesub? | 왜 onesub인가?

<table>
<tr><th></th><th>RevenueCat</th><th>onesub</th></tr>
<tr>
  <td><b>Setup</b></td>
  <td>SDK + Dashboard + 10 hours</td>
  <td><code>"Add subscription"</code> → MCP → 30 min</td>
</tr>
<tr>
  <td><b>Concepts</b></td>
  <td>Offerings, Entitlements, Packages...</td>
  <td><code>isActive: true / false</code></td>
</tr>
<tr>
  <td><b>Pricing</b></td>
  <td>% of revenue</td>
  <td>Free (self-host) or $29/mo (hosted)</td>
</tr>
<tr>
  <td><b>Source</b></td>
  <td>Closed</td>
  <td>MIT Open Source</td>
</tr>
</table>

> **한국어 요약**: RevenueCat은 Offering, Entitlement, Package 같은 복잡한 개념을 알아야 합니다. onesub는 `isActive: true/false` 하나면 됩니다. MCP로 AI에게 "구독 달아줘"라고 말하면 30분 안에 끝납니다.

---

## Architecture | 구조

```
┌─────────────────────────────────────────────────────┐
│  Your Mobile App (React Native / Expo)              │
│                                                     │
│  ┌─────────────────────────────────────────────┐    │
│  │  onesub SDK                                 │    │
│  │  ┌──────────────┐  ┌────────────────────┐   │    │
│  │  │ useOneSub()  │  │ <Paywall />        │   │    │
│  │  │ isActive     │  │ Ready-to-use UI    │   │    │
│  │  │ subscribe()  │  │ or build your own  │   │    │
│  │  │ restore()    │  │                    │   │    │
│  │  └──────┬───────┘  └────────────────────┘   │    │
│  └─────────┼───────────────────────────────────┘    │
│            │ receipt                                 │
└────────────┼────────────────────────────────────────┘
             ▼
┌─────────────────────────────────────────────────────┐
│  Your Backend (Express / any Node.js)               │
│                                                     │
│  app.use(createOneSubMiddleware(config))             │
│                                                     │
│  POST /onesub/validate    ← Receipt validation      │
│  GET  /onesub/status      ← Subscription check      │
│  POST /onesub/webhook/*   ← Store notifications     │
│                                                     │
│  ┌──────────┐  ┌──────────┐  ┌────────────────┐    │
│  │  Apple   │  │  Google  │  │ Subscription   │    │
│  │ StoreKit │  │ Play API │  │ Store          │    │
│  │    2     │  │    v3    │  │ (pluggable)    │    │
│  └──────────┘  └──────────┘  └────────────────┘    │
└─────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────┐
│  @onesub/mcp-server (AI Integration)                │
│                                                     │
│  "Add a monthly subscription at $4.99"              │
│           ↓                                         │
│  onesub_setup        → Full integration code        │
│  onesub_add_paywall  → Custom paywall component     │
│  onesub_check_status → Live subscription status     │
│  onesub_troubleshoot → IAP issue diagnosis          │
└─────────────────────────────────────────────────────┘
```

---

## Packages | 패키지

| Package | Description | 설명 |
|---------|-------------|------|
| `onesub` | React Native SDK — `useOneSub()` hook + `<Paywall />` | 모바일 SDK |
| `@onesub/server` | Express middleware — receipt validation + webhooks | 서버 미들웨어 |
| `@onesub/mcp-server` | MCP tools — AI sets up your subscription | AI 통합 도구 |
| `@onesub/shared` | Shared TypeScript types and constants | 공유 타입 |

---

## Quick Start | 빠른 시작

### 1. Install | 설치

```bash
# Mobile app
npm install onesub react-native-iap

# Backend
npm install @onesub/server
```

### 2. Server | 서버

```ts
import express from 'express';
import { createOneSubMiddleware } from '@onesub/server';

const app = express();

app.use(createOneSubMiddleware({
  apple: {
    bundleId: 'com.yourapp.id',
    sharedSecret: process.env.APPLE_SHARED_SECRET,
  },
  google: {
    packageName: 'com.yourapp.id',
    serviceAccountKey: process.env.GOOGLE_SERVICE_ACCOUNT_KEY,
  },
  database: { url: process.env.DATABASE_URL },
}));

app.listen(4100);
```

### 3. App Root | 앱 루트

```tsx
import { OneSubProvider } from 'onesub';

export default function App() {
  return (
    <OneSubProvider
      config={{
        serverUrl: 'https://api.yourapp.com',
        productId: 'premium_monthly',
      }}
      userId={currentUserId}
    >
      <Navigation />
    </OneSubProvider>
  );
}
```

### 4. Paywall | 페이월

```tsx
import { useOneSub, Paywall } from 'onesub';

export function PremiumScreen() {
  const { isActive, isLoading, subscribe, restore } = useOneSub();

  if (isLoading) return <LoadingSpinner />;

  if (!isActive) {
    return (
      <Paywall
        config={{
          title: 'Go Premium',
          features: ['Unlimited access', 'No ads', 'Priority support'],
          price: '$4.99/month',
          ctaText: 'Subscribe Now',
        }}
        onSubscribe={subscribe}
        onRestore={restore}
      />
    );
  }

  return <PremiumContent />;
}
```

**That's it. No Offerings. No Entitlements. No dashboard.**

---

## AI Setup (MCP) | AI 설정

Add to your Claude Code / Cursor config:

```json
{
  "mcpServers": {
    "onesub": {
      "command": "npx",
      "args": ["@onesub/mcp-server"]
    }
  }
}
```

Then just ask your AI:

> **English**: "Add a monthly subscription at $4.99 to my Expo app"
>
> **한국어**: "내 Expo 앱에 월 4,900원 구독 추가해줘"

The MCP server provides 4 tools:

| Tool | Description | 설명 |
|------|-------------|------|
| `onesub_setup` | Analyze project & generate integration code | 프로젝트 분석 + 통합 코드 생성 |
| `onesub_add_paywall` | Generate a customized paywall screen | 맞춤 페이월 화면 생성 |
| `onesub_check_status` | Check subscription status via API | 구독 상태 확인 |
| `onesub_troubleshoot` | Diagnose common IAP issues | IAP 문제 진단 |

---

## Self-Hosting | 셀프호스트

onesub is just an Express middleware. Deploy anywhere:

```bash
# Standalone
node -e "
  import('@onesub/server').then(({ createOneSubServer }) =>
    createOneSubServer({ ... }).listen(4100)
  )
"

# Or mount in your existing Express app — one line:
app.use(createOneSubMiddleware(config));
```

---

## Custom Store | 커스텀 저장소

Default is in-memory. Plug in your own database:

> 기본값은 인메모리입니다. PostgreSQL, Redis 등 원하는 저장소를 연결하세요.

```ts
import { SubscriptionStore, createOneSubMiddleware } from '@onesub/server';

class PrismaStore implements SubscriptionStore {
  async save(sub) {
    await prisma.subscription.upsert({
      where: { originalTransactionId: sub.originalTransactionId },
      update: sub,
      create: sub,
    });
  }
  async getByUserId(userId) {
    return prisma.subscription.findFirst({
      where: { userId, status: 'active' },
    });
  }
  async getByTransactionId(txId) {
    return prisma.subscription.findFirst({
      where: { originalTransactionId: txId },
    });
  }
}

app.use(createOneSubMiddleware({
  ...config,
  store: new PrismaStore(),
}));
```

---

## Roadmap | 로드맵

- [x] React Native SDK (`useOneSub` + `<Paywall />`)
- [x] Express server middleware (receipt validation + webhooks)
- [x] MCP server (AI-powered setup)
- [ ] Flutter SDK
- [ ] Hosted service (no server needed)
- [ ] A/B testing for paywalls
- [ ] Analytics dashboard
- [ ] Stripe integration for web

---

## Philosophy | 철학

```
RevenueCat:  Offering → Entitlement → Package → Product → StoreProduct → ...
onesub:      isActive? → true / false
```

90% of indie apps need **one monthly subscription and a paywall**. That's exactly what onesub does. Nothing more.

> 인디 앱의 90%는 **월 구독 하나와 페이월 하나**면 충분합니다.
> onesub는 정확히 그것만 합니다. 그 이상 없습니다.

---

## Contributing | 기여

PRs welcome! See [CLAUDE.md](CLAUDE.md) for project structure and conventions.

```bash
git clone https://github.com/jeonghwanko/onesub.git
cd onesub
npm install
npm run build
```

---

## License | 라이선스

[MIT](LICENSE) - Use it however you want.

---

<p align="center">
  <strong>onesub</strong> — because subscriptions shouldn't be complicated.<br/>
  구독이 복잡할 이유는 없습니다.
</p>
