# @jeonghwanko/onesub-sdk

React Native SDK for [onesub](https://github.com/jeonghwanko/onesub) — drop-in `useOneSub()` hook + `<Paywall />` component built on `react-native-iap` v15.

```bash
npm install @jeonghwanko/onesub-sdk react-native-iap
```

## Usage

```tsx
import { OneSubProvider, useOneSub } from '@jeonghwanko/onesub-sdk';

// Wrap your app
<OneSubProvider config={{ serverUrl: 'https://api.yourapp.com', productId: 'pro_monthly' }} userId={userId}>
  <App />
</OneSubProvider>

// In any component
function PaywallScreen() {
  const { isActive, subscribe, restore, purchaseProduct, restoreProduct } = useOneSub();

  // Subscriptions
  if (!isActive) return <Button onPress={subscribe} title="Subscribe" />;

  // One-time products
  const result = await purchaseProduct('credits_100', 'consumable');
  // result: null on cancel, (PurchaseInfo & { action?: 'new' | 'restored' }) on success

  // Restore a non-consumable
  const restored = await restoreProduct('premium_unlock', 'non_consumable');
}
```

## Config options

| Option | Purpose |
|--------|---------|
| `serverUrl` | Base URL of your `@onesub/server` backend |
| `productId` | Default subscription product ID |
| `appleProductId` / `googleProductId` | Platform-specific overrides (optional) |
| `mockMode` | Return synthetic success without calling `react-native-iap` or the server. For Expo Go / simulator UI testing. **Never enable in production.** |

## Requirements

- `react-native-iap` **v15+** (event-based purchase flow)
- React Native 0.71+
- `@onesub/server` running somewhere reachable

## Links

- Repo: <https://github.com/jeonghwanko/onesub>
- Server package: [`@onesub/server`](https://www.npmjs.com/package/@onesub/server)
- Migration guide: [`docs/MIGRATION.md`](https://github.com/jeonghwanko/onesub/blob/master/docs/MIGRATION.md)

MIT © onesub contributors.
