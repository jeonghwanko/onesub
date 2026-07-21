---
"@onesub/providers": minor
---

Fix one-time IAP product creation against the current store APIs.

- **Apple**: create / update / delete / pricePoints now target the standalone
  `/v2/inAppPurchases` resource. The previous `POST /v1/inAppPurchasesV2` path is
  rejected by App Store Connect with "The path provided does not match a defined
  resource type". The app→IAP relationship list (`/v1/apps/{id}/inAppPurchasesV2`)
  and price schedules (`/v1/inAppPurchasePriceSchedules`) remain on v1.
- **Google Play**: migrate one-time product create / update / delete / list from
  the deprecated `inappproducts` API (writes now fail with "Please migrate to the
  new publishing API") to `monetization.onetimeproducts` (purchaseOptions +
  regional pricing/availability, `{units, nanos}` money). New products are created
  with a DRAFT purchase option — activate in Play Console after creation.
