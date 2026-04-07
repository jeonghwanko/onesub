# onesub Expo example

Minimal Expo Router app with `@onesub/sdk` integration.

## Quick Start

```bash
cd examples/expo-app
npm install
npx expo start
```

## What this demonstrates

1. **`_layout.tsx`** — Wraps the app with `<OneSubProvider>`
2. **`index.tsx`** — Uses `useOneSub()` to check subscription and show paywall

```tsx
const { isActive, subscribe, restore } = useOneSub();

if (!isActive) return <Paywall />;
return <PremiumContent />;
```

## Configuration

Edit `app/_layout.tsx`:

```ts
const SERVER_URL = 'http://YOUR_PC_IP:4100';  // your onesub server
const PRODUCT_ID = 'premium_monthly';          // your App Store / Google Play product ID
const USER_ID = 'your-user-id';                // from your auth system
```

## Prerequisites

1. Run the server example first: `cd ../server && npm start`
2. Create a subscription product in App Store Connect / Google Play Console
3. Use a physical device (IAP doesn't work in simulators)
