# onesub

**One subscription. That's it.**

Monthly subscription + paywall for mobile apps. AI-native, open-source, dead simple.

```tsx
import { OneSubProvider, useOneSub, Paywall } from 'onesub';

const { isActive, subscribe } = useOneSub();

if (!isActive) return <Paywall config={config} onSubscribe={subscribe} />;
```

## Why onesub?

| | RevenueCat | onesub |
|---|---|---|
| Setup | SDK + Dashboard + 10 hours | `"Add subscription"` → MCP → 30 min |
| Concepts | Offerings, Entitlements, Packages... | `isActive: true/false` |
| Pricing | % of revenue | Free (self-host) or $29/mo (hosted) |
| Source | Closed | MIT Open Source |

## Packages

| Package | Description |
|---------|-------------|
| `onesub` | React Native SDK — `useOneSub()` hook + `<Paywall />` |
| `@onesub/server` | Express middleware — receipt validation + webhooks |
| `@onesub/mcp-server` | MCP tools — AI sets up your subscription |
| `@onesub/shared` | Shared types and constants |

## Quick Start

### 1. Install

```bash
# In your React Native app
npm install onesub react-native-iap

# In your backend
npm install @onesub/server
```

### 2. Server Setup

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
  database: {
    url: process.env.DATABASE_URL,
  },
}));

app.listen(4100);
```

### 3. App Setup

```tsx
// App root
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

### 4. Add Paywall

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

## AI Setup (MCP)

Add to your Claude Code / Cursor MCP config:

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

Then just ask:

> "Add a monthly subscription at $4.99 to my app"

The AI will analyze your project and generate all the code.

## Self-Hosting

onesub server is just an Express middleware. Deploy it anywhere:

```bash
# Docker
docker run -p 4100:4100 \
  -e APPLE_BUNDLE_ID=com.yourapp \
  -e GOOGLE_PACKAGE_NAME=com.yourapp \
  onesub/server

# Or add to your existing Express app
app.use(createOneSubMiddleware(config));
```

## Custom Subscription Store

Default is in-memory. Bring your own:

```ts
import { SubscriptionStore, createOneSubMiddleware } from '@onesub/server';

class PostgresStore implements SubscriptionStore {
  async save(sub) { /* INSERT INTO subscriptions ... */ }
  async getByUserId(userId) { /* SELECT ... WHERE user_id = ... */ }
  async getByTransactionId(txId) { /* SELECT ... WHERE tx_id = ... */ }
}

app.use(createOneSubMiddleware({
  ...config,
  store: new PostgresStore(),
}));
```

## License

MIT
