# onesub Unity SDK

Unity IAP purchases are sent to a self-hosted onesub server before the store
transaction is confirmed. This prevents content from being granted when server
validation fails and lets unconfirmed purchases be retried after reconnecting.

The host game must set `OneSubPurchasing.UserIdProvider` and configure a non-empty
server URL before making production purchases.

`OneSubPlatformServices` is the optional game-services/review/sharing adapter used
by PenguinRun. Sharing requires `com.unitynative.sharing` to be installed by the
host project because that Git package is not available from Unity's registry.
