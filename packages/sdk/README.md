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
| `debug` | When `true`, emit verbose `[onesub]` traces at every step (IAP connection, listener events, in-flight matches, server validations, `finishTransaction`, drain transitions). Recommended when diagnosing an integration. |
| `logger` | Custom log sink (`{ info, warn, error }`). Defaults to `console`. Works with `pino` / `winston` / any compatible logger. |

### Debug mode

Set `debug: true` to see what the SDK is actually doing:

```tsx
<OneSubProvider
  config={{ serverUrl, productId, debug: __DEV__ }}
  userId={userId}
>
  <App />
</OneSubProvider>
```

Sample output when a user subscribes:

```
[onesub] provider mount { serverUrl: ..., userId: 'user_1', mockMode: false }
[onesub] initConnection start
[onesub] initConnection ok
[onesub] listeners attached; drain window open { drainMs: 2500 }
[onesub] drain released { reason: 'timeout', waiters: 0 }
[onesub] subscribe() called { productId: 'pro_monthly', drainReady: true }
[onesub] event received { productId: 'pro_monthly', transactionId: 'tx_42', productType: 'subs', hasInFlight: true, matchingAllowed: true, matched: true }
[onesub] validating { productId: 'pro_monthly', platform: 'apple', kind: 'subscription' }
[onesub] subscription validated { productId: 'pro_monthly', action: 'new', active: true }
```

If something goes wrong, trace shows exactly where: the `matched` flag distinguishes in-flight matches from orphan replays, `matchingAllowed` reveals drain-window state, and `action: 'restored'` vs `'new'` tells you whether the server treated the receipt as a first-time purchase.

### Structured errors

Every `Error` thrown by the SDK is a `OneSubError` with a machine-readable `code`:

```tsx
import { OneSubError, ONESUB_ERROR_CODE } from '@jeonghwanko/onesub-sdk';

try {
  await purchaseProduct('premium', 'non_consumable');
} catch (err) {
  if (err instanceof OneSubError) {
    switch (err.code) {
      case ONESUB_ERROR_CODE.USER_CANCELLED: return;
      case ONESUB_ERROR_CODE.NON_CONSUMABLE_ALREADY_OWNED:
        return Alert.alert('이미 구매한 상품입니다.');
      case ONESUB_ERROR_CODE.PURCHASE_TIMEOUT:
      case ONESUB_ERROR_CODE.NETWORK_ERROR:
        return Alert.alert('네트워크 상태를 확인해주세요.');
      default:
        return Alert.alert('결제 실패', err.message);
    }
  }
  throw err;
}
```

## Requirements

- `react-native-iap` **v15+** (event-based purchase flow)
- React Native 0.71+
- `@onesub/server` running somewhere reachable

## Links

- Repo: <https://github.com/jeonghwanko/onesub>
- Server package: [`@onesub/server`](https://www.npmjs.com/package/@onesub/server)
- Migration guide: [`docs/MIGRATION.md`](https://github.com/jeonghwanko/onesub/blob/master/docs/MIGRATION.md)

MIT © onesub contributors.
