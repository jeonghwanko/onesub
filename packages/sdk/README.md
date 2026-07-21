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
  const {
    isActive,
    isBusy,
    subscribeWithResult,
    purchaseProduct,
    restoreProduct,
  } = useOneSub();

  async function handleFastSubscribe() {
    // Resolves for this exact purchase as soon as the server validates it.
    // Keep every other IAP action disabled while isBusy remains true because
    // native transaction cleanup is still running.
    const result = await subscribeWithResult();
    if (result) showSubscriptionSuccess(result.subscription);
  }

  return (
    <>
      {!isActive && <Button disabled={isBusy} onPress={handleFastSubscribe} title="Subscribe" />}
      <Button
        disabled={isBusy}
        onPress={() => purchaseProduct('credits_100', 'consumable')}
        title="Buy credits"
      />
      <Button
        disabled={isBusy}
        onPress={() => restoreProduct('premium_unlock', 'non_consumable')}
        title="Restore unlock"
      />
    </>
  );
}
```

## Config options

| Option | Purpose |
|--------|---------|
| `serverUrl` | Base URL of your `@onesub/server` backend |
| `productId` | Default subscription product ID |
| `appleProductId` / `googleProductId` | Platform-specific overrides (optional) |
| `appId` | Which app this client is on a multi-app server (`OneSubServerConfig.apps`) — the app's `id`, Apple bundleId, or Google packageName. **Required for non-default apps on Android**: a Google purchase token doesn't name its package, so without it validation falls back to the default app's credentials and is rejected. |
| `consumableProductIds` | Every consumable product ID you sell. **Required if you sell consumables** — see below. |
| `mockMode` | Return synthetic success without calling `react-native-iap` or the server. For Expo Go / simulator UI testing. **Never enable in production.** |
| `debug` | When `true`, emit verbose `[onesub]` traces at every step (IAP connection, listener events, in-flight matches, server validations, `finishTransaction`, drain transitions). Recommended when diagnosing an integration. |
| `logger` | Custom log sink (`{ info, warn, error }`). Defaults to `console`. Works with `pino` / `winston` / any compatible logger. |

### Selling consumables — declare them

If you sell consumables, list every consumable product ID in `consumableProductIds`:

```tsx
<OneSubProvider
  config={{
    serverUrl,
    productId: 'pro_monthly',
    consumableProductIds: ['credits_10', 'credits_50', 'credits_200'],
  }}
  userId={userId}
>
```

A store transaction says only `subs` vs `inapp` — it never says whether a product is consumable.
Normally the SDK learns that from your `purchaseProduct(id, 'consumable')` call. But if the app dies
between payment and validation, the store redelivers that transaction at the next launch as an
**orphan replay**, with no call to learn from. Without this list the SDK falls back to
`non_consumable`, and both consequences are permanent and silent:

- the server records `type: 'non_consumable'`, so host code that grants consumables by type never
  sees the purchase — the user paid and got nothing;
- `finishTransaction` acknowledges instead of consuming, so on Android the SKU stays owned and that
  product can never be bought again.

Declaring the IDs makes the replay resolve exactly as the original call would have. An explicit
`purchaseProduct(id, type)` always wins over the list, so a stale entry cannot override a live call.
Subscriptions do not belong here — they are detected from the transaction itself.

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
- React Native 0.73+ and React 19.2.6+
- `@onesub/server` running somewhere reachable

The authoritative floors are the `peerDependencies` in this package's `package.json`.

## Links

- Repo: <https://github.com/jeonghwanko/onesub>
- Server package: [`@onesub/server`](https://www.npmjs.com/package/@onesub/server)
- Migration guide: [`docs/MIGRATION.md`](https://github.com/jeonghwanko/onesub/blob/master/docs/MIGRATION.md)

MIT © onesub contributors.
