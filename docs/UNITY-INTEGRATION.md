# Unity Integration Guide

This guide integrates the public `com.onesub.unity` Core package with Unity IAP and a self-hosted
OneSub server. Core handles product fetch, purchase, restore/revalidation, localized price lookup,
server receipt validation, and purchase confirmation. The game still owns authentication,
entitlement persistence, fulfillment, shop/paywall UI, and player messaging.

## Requirements

- Unity 2022.3 or newer.
- Unity IAP 5.4.0. The UPM package declares `com.unity.purchasing` automatically.
- Store products created in App Store Connect and/or Google Play Console.
- A reachable `@onesub/server` deployment configured for the Unity application identifiers.
- A stable signed-in player ID supplied by the host game.

Do not put Apple/Google private keys, service-account JSON, database URLs, admin secrets, receipts,
or purchase tokens in Unity assets. Only the public server URL and store product IDs belong in
`OneSubSettings`.

## Runtime Flow

```text
Player taps Buy
    -> Unity IAP creates a pending order
    -> OneSub Unity sends JWS/purchase token to @onesub/server
    -> server verifies and records the purchase
    -> Unity Core emits entitlement/purchase events
    -> Unity IAP confirms the pending order
```

The order is confirmed only after OneSub returns an entitled result. A timeout or unavailable server
does not revoke a cached subscription, and an unconfirmed pending order can be retried after the
store reconnects.

## 1. Configure the OneSub Server

For one Unity app, the Apple bundle ID and Google package name should match Unity Player Settings:

```ts
app.use(createOneSubMiddleware({
  apple: {
    bundleId: 'com.example.game',
    keyId: process.env.APPLE_KEY_ID,
    issuerId: process.env.APPLE_ISSUER_ID,
    privateKey: process.env.APPLE_PRIVATE_KEY,
  },
  google: {
    packageName: 'com.example.game',
    serviceAccountKey: process.env.GOOGLE_SERVICE_ACCOUNT_KEY,
    pushAudience: 'https://api.example.com/onesub/webhook/google',
    pushServiceAccountEmail: process.env.GOOGLE_PUSH_SERVICE_ACCOUNT_EMAIL,
  },
  database: { url: databaseUrl },
  store,
  purchaseStore,
}));
```

Unity sends `Application.identifier` as `appId` on every validation request. For a server shared by
several games, configure every identifier explicitly:

```ts
app.use(createOneSubMiddleware({
  database: { url: databaseUrl },
  apps: [
    {
      id: 'com.example.game.ios',
      apple: { bundleId: 'com.example.game.ios' },
    },
    {
      id: 'com.example.game.android',
      google: {
        packageName: 'com.example.game.android',
        serviceAccountKey: androidServiceAccountKey,
      },
    },
  ],
  store,
  purchaseStore,
}));
```

An explicit unknown `appId` fails closed. If Unity Player Settings and server configuration differ,
validation returns a provider-configuration error rather than trying another game's credentials.
See [`CONFIGURATION.md`](CONFIGURATION.md) and [`DEPLOYMENT.md`](DEPLOYMENT.md) for durable stores,
webhook authentication, and production topology.

## 2. Install the Unity Package

In Unity Package Manager, choose **Add package from git URL** and enter:

```text
https://github.com/jeonghwanko/onesub.git?path=/packages/unity
```

Equivalent `Packages/manifest.json` entry:

```json
{
  "dependencies": {
    "com.onesub.unity": "https://github.com/jeonghwanko/onesub.git?path=/packages/unity"
  }
}
```

For reproducible production builds, append a known tag or commit revision after the path URL rather
than tracking the default branch. When developing from a local clone, Package Manager can add
`packages/unity/package.json` from disk.

The Core runtime assembly references only `Unity.Purchasing`. Do not install
`com.onesub.unity.platform-services` unless the project specifically needs its optional PenguinRun
sharing, review, leaderboard, and authentication helpers.

## 3. Create Store Products

Create the same IDs and types in the store consoles and Unity settings:

| OneSub type | Unity IAP type | Example |
|---|---|---|
| `Subscription` | `ProductType.Subscription` | `pro_monthly` |
| `NonConsumable` | `ProductType.NonConsumable` | `lifetime_unlock` |
| `Consumable` | `ProductType.Consumable` | `coins_100` |

The runtime builds Unity IAP `ProductDefinition` objects directly; a Unity IAP Catalog is not
required. Apple and Google may use different application identifiers, but each platform's product ID
must match the ID configured in the `OneSubSettings` asset for that build.

Store-side products can also be managed through `@onesub/providers` or `@onesub/mcp-server`. Always
list and review existing products before creating, renaming, or deleting them.

## 4. Create a OneSubSettings Asset

In the Unity Editor, choose:

```text
Assets -> Create -> OneSub -> Settings
```

Configure:

- **Server URL**: the public base URL, such as `https://api.example.com`.
- **Products**: each store product ID and its `Consumable`, `NonConsumable`, or `Subscription` type.

Settings validation rejects:

- Missing/non-HTTP(S) server URLs.
- URLs containing credentials, query strings, or fragments.
- An empty product list.
- Empty, whitespace-padded, duplicate, or invalid product definitions.

Production mobile builds should use HTTPS. `localhost` on a physical device means the device itself,
not the development computer; use a reachable development host when device testing.

## 5. Provide a Stable Player ID

Implement `IOneSubUserIdProvider` with the game's authenticated account identity:

```csharp
using OneSub.Unity;
using UnityEngine;

public sealed class GameUserIdProvider : MonoBehaviour, IOneSubUserIdProvider
{
    public string GetUserId()
    {
        // Replace with the stable ID from the game's authentication system.
        return PlayerSession.Current.UserId;
    }
}
```

Do not use a display name, scene-local object ID, random value generated on every launch, or an ID
that changes after reinstall. `Buy()` rejects an empty player ID. Initialize only after authentication
can return the final account identity, or provide a delegate that resolves the current signed-in ID.

## 6. Initialize and Subscribe to Events

Create a bootstrap component and subscribe before calling `Initialize()`:

```csharp
using OneSub.Unity;
using UnityEngine;

public sealed class OneSubBootstrap : MonoBehaviour
{
    [SerializeField] private OneSubSettings settings;
    [SerializeField] private GameUserIdProvider userIdProvider;

    private OneSubPurchasing purchasing;

    private void Awake()
    {
        purchasing = OneSubPurchasing.Instance;
        purchasing.Initialized += OnInitialized;
        purchasing.PurchaseSucceeded += OnPurchaseSucceeded;
        purchasing.PurchaseFailed += OnPurchaseFailed;
        purchasing.ValidationFailed += OnValidationFailed;
        purchasing.SubscriptionChanged += OnSubscriptionChanged;

        purchasing.Initialize(settings, userIdProvider);
    }

    private void OnDestroy()
    {
        if (purchasing == null) return;
        purchasing.Initialized -= OnInitialized;
        purchasing.PurchaseSucceeded -= OnPurchaseSucceeded;
        purchasing.PurchaseFailed -= OnPurchaseFailed;
        purchasing.ValidationFailed -= OnValidationFailed;
        purchasing.SubscriptionChanged -= OnSubscriptionChanged;
    }

    private void OnInitialized(bool success)
    {
        ShopView.SetPurchasesEnabled(success);
        if (!success) Debug.LogError("OneSub/Unity IAP initialization failed.");
    }

    private void OnPurchaseSucceeded(string productId, OneSubValidationResult result)
    {
        Debug.Log($"Validated purchase: {productId}, action={result.action}");

        if (result.purchase != null)
        {
            Fulfillment.ApplyOnce(result.purchase.transactionId, result.purchase);
        }
    }

    private void OnPurchaseFailed(string productId, string message)
    {
        // This event is only for a purchase the player explicitly started.
        ShopView.ShowPurchaseError(productId, message);
    }

    private void OnValidationFailed(string productId, string message)
    {
        // Background restore/revalidation failure: log or retry quietly.
        // Do not show it as a failed purchase and do not revoke cached access.
        Debug.LogWarning($"Background OneSub validation failed ({productId}): {message}");
    }

    private void OnSubscriptionChanged(string productId, OneSubEntitlementState state)
    {
        switch (state)
        {
            case OneSubEntitlementState.Entitled:
                EntitlementCache.SetSubscription(productId, true);
                break;
            case OneSubEntitlementState.NotEntitled:
                EntitlementCache.SetSubscription(productId, false);
                break;
            case OneSubEntitlementState.Unknown:
                // Server/store did not answer. Preserve the cached value.
                break;
        }
    }
}
```

`OneSubPurchasing` creates a `DontDestroyOnLoad` singleton automatically. Avoid adding a second
instance manually. `ExistingInstance` returns the current instance without creating one.

The lower-level initialization overload remains available when a ScriptableObject is unsuitable:

```csharp
OneSubPurchasing.Instance.Initialize(
    new[]
    {
        new OneSubProductDefinition("pro_monthly", OneSubProductType.Subscription),
        new OneSubProductDefinition("coins_100", OneSubProductType.Consumable),
    },
    "https://api.example.com",
    () => PlayerSession.Current.UserId);
```

It applies the same URL/product validation rules as `OneSubSettings`.

## 7. Build the Shop UI

Do not enable purchase buttons until `Initialized(true)` fires.

```csharp
public void BuyMonthlySubscription()
{
    OneSubPurchasing.Instance.Buy("pro_monthly");
}

public void BuyCoins()
{
    OneSubPurchasing.Instance.Buy("coins_100");
}

public void Restore()
{
    OneSubPurchasing.Instance.RestorePurchases();
}

public string MonthlyPrice()
{
    return OneSubPurchasing.Instance.GetLocalizedPrice("pro_monthly") ?? "—";
}
```

`GetProduct()` and `GetLocalizedPrice()` return `null` until the store has returned its catalog.
`Buy()` reports a user-visible `PurchaseFailed` when the store is not initialized, the product is
missing, or the player is not signed in.

Initialization automatically fetches existing purchases after products load. `RestorePurchases()`
requests the same fetch again for an explicit Restore button. Confirmed consumables are intentionally
not restored.

## 8. Handle Events Correctly

| Event | Meaning | Recommended host behavior |
|---|---|---|
| `Initialized(bool)` | Store connection/product fetch completed or failed | Enable/disable purchase UI |
| `PurchaseSucceeded(productId, result)` | A player-initiated pending order was validated and will be confirmed | Persist entitlement or fulfill once by transaction ID |
| `PurchaseFailed(productId, message)` | A player-initiated purchase failed/deferred/rejected | Show contextual UI |
| `ValidationFailed(productId, message)` | Background fetch/restore/revalidation failed | Log/retry quietly; preserve cached access |
| `SubscriptionChanged(productId, state)` | Subscription entitlement became known or unknown | Apply the tri-state rules below |

`OneSubEntitlementState` is deliberately tri-state:

- `Entitled`: grant/cache subscription access.
- `NotEntitled`: authoritative store/server result; revoke cached subscription access.
- `Unknown`: configuration, transport, timeout, throttling, authentication, or invalid-response
  failure; keep the previous cached decision.

Never convert `Unknown` to false. Doing so removes access from a paying offline player because a
server happened to be unavailable.

## 9. Fulfill One-Time Purchases Safely

For a non-consumable, persist the entitlement by stable player ID and product ID. For a consumable,
maintain a host fulfillment ledger keyed by `result.purchase.transactionId`:

```text
if transactionId already fulfilled:
    do nothing
else:
    atomically grant currency/item
    record transactionId as fulfilled
```

Do not use only `result.action == "new"` as the fulfillment guarantee. A server may have recorded a
transaction before the client received the response; a retry then returns `restored` even though the
game still needs to reconcile its own fulfillment ledger.

## 10. Test Locally

Build the repository and start the current Core mock server:

```bash
npm run build
node packages/cli/dist/index.js dev --port 4100
```

The CLI mock server binds to loopback and is intended for the Unity Editor on the same computer. It
uses the app identity `mock.onesub.dev`, while Unity always sends `Application.identifier`; set the
Editor/test application identifier to `mock.onesub.dev` or run a custom mock server configured for
the project's actual identifier.

Use `http://localhost:4100` in the test `OneSubSettings` asset. The CLI server cannot be reached from
a physical device because it binds to `127.0.0.1`. For device testing, run a deliberately LAN-bound
development host with matching `apps` configuration and restrict it to the development network.

Real Apple JWS validation requires an iOS store build/TestFlight transaction. Real Google validation
requires a Play test-track purchase token. Configure store webhooks as well as client validation;
webhooks keep server state correct after renewal, cancellation, grace period, refund, and expiry.

## Core Limitations and Extension Points

- The Core client sends JSON with only `Content-Type`; it has no custom authorization-header hook.
  If validation routes require a host bearer token, provide a game-specific HTTP adapter/gateway or
  extend Core without putting server secrets in the client.
- Background restore publishes subscription state through `SubscriptionChanged`. Confirmed
  non-consumables are revalidated, but Core currently has no separate restored-non-consumable event.
  Games that need that result in UI should query `/onesub/purchase/status` through their authenticated
  backend or add a project-specific adapter.
- Core does not implement a paywall/shop screen, player authentication, entitlement database, remote
  configuration, analytics, or customer-support UI.
- Core sends `Application.identifier` for multi-app routing but does not bind the store purchase to a
  separate account token. The host must still secure account identity and fulfillment.

Commercial project auditing, code generation, and end-to-end Unity Editor automation are outside
public Core. See [`UNITY-PRO.md`](UNITY-PRO.md) for the Core/Pro boundary.

## Troubleshooting

| Symptom | Check |
|---|---|
| Initialization returns false | Settings validation, store availability, product approval/track, exact product IDs |
| Product or price is null | Wait for `Initialized(true)`; verify the store returned the configured product |
| Server reports provider config missing | Unity `Application.identifier` does not match server app/bundle/package configuration |
| Purchase remains pending | Inspect `ValidationFailed`, network reachability, server logs, and receipt error code |
| Subscription disappears while offline | Host incorrectly converted `Unknown` to `NotEntitled`; preserve cached access |
| Duplicate consumable grant | Fulfillment is not atomically deduplicated by transaction ID |
| Works in Editor, not on device | `localhost`/cleartext HTTP/network reachability or real store credentials/build track differ |
| Google validation targets wrong app | Configure the package name as an app identity; Google tokens cannot identify the package themselves |

For server receipt errors, see [`RECEIPT-ERRORS.md`](RECEIPT-ERRORS.md). For Unity package tests and
the Core boundary validator, see [`TESTING.md`](TESTING.md#unity-tests).
