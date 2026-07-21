---
"@onesub/providers": patch
---

Fix two one-time IAP create failures found against the live store APIs.

- **Apple**: the inline-created price in the price schedule used a plain id
  (`p_0`). App Store Connect requires a *local id* of the literal form `${...}`
  and otherwise rejects the schedule with `ENTITY_ERROR.INCLUDED.INVALID_ID` —
  the IAP was still created, just permanently priceless, so the failure was easy
  to miss. Now uses `${price-0}`.
- **Google Play**: the listing language was hardcoded to `en-US`, so creating a
  product on an app whose default store language is something else failed with
  "Missing the listing for the default language xx-XX". The app's default
  language is now detected (via a throwaway edit) and used for the listing,
  falling back to `en-US` if detection fails.
