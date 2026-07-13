# Changelog

## 0.2.0

- Add `OneSubSettings` and `IOneSubUserIdProvider` for asset-based initialization.
- Keep the existing product/server URL initialization API backward compatible.
- Move PenguinRun sharing, review, leaderboard, and authentication helpers out of the purchasing
  package into `com.onesub.unity.platform-services`.
- Compile the optional platform-services assembly only when Unity Native Sharing 1.x is installed.
- Add Unity 2022.3 and Unity 6 settings validation coverage.
- Apply the same URL and product validation to settings-based and low-level initialization.
- Reject credentials, query strings, fragments, product ID whitespace, duplicate IDs, and invalid
  product types before connecting to Unity IAP.

## 0.1.2

- Send the Unity application identifier so one OneSub server can validate purchases for many apps.

## 0.1.1

- Preserve cached subscription entitlement when the OneSub server is unreachable.

## 0.1.0

- Add Unity IAP 5 purchasing, restore, receipt validation, and entitlement events.
