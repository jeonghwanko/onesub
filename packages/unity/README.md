# onesub Unity SDK

This package is **OneSub Core for Unity**. It is MIT-licensed and provides the complete runtime
purchase and server-validation flow. Integration with a game's authentication, entitlement cache,
shop, and paywall is intentionally performed by the host project.

Unity IAP purchases are sent to a self-hosted onesub server before the store
transaction is confirmed. This prevents content from being granted when server
validation fails and lets unconfirmed purchases be retried after reconnecting.

The host game can initialize the SDK with a `OneSubSettings` asset and an
`IOneSubUserIdProvider`, or continue using the lower-level product/server URL overload.

```csharp
OneSubPurchasing.Instance.Initialize(settings, userIdProvider);
```

`OneSubSettings` validates the public server URL and product IDs before Unity IAP connects. Store
credentials, database URLs, admin secrets, receipts, and purchase tokens must never be stored in the
asset.

For installation, server setup, settings creation, event handling, entitlement caching, fulfillment,
restore behavior, local testing, and troubleshooting, follow the complete
[`Unity Integration Guide`](../../docs/UNITY-INTEGRATION.md).

## Optional PenguinRun platform services

`OneSubPlatformServices` is the optional game-services/review/sharing adapter used by PenguinRun. It
now lives in the separate `com.onesub.unity.platform-services` package. The purchasing package has
no sharing, review, leaderboard, authentication, or Google Play Review dependency.

Projects that need the PenguinRun helpers must install the optional package and Unity Native Sharing
1.x explicitly. Projects with their own platform-service stack should install only this Core package.

Commercial Unity Editor automation and MCP for Unity custom tools are developed separately in the
private `onesub-unity-pro` repository. Core remains usable without Pro. See
[`docs/UNITY-PRO.md`](../../docs/UNITY-PRO.md) for the product and compatibility boundary.
