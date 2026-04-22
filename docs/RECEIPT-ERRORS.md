# Receipt & Purchase Errors

Troubleshooting guide for every `ONESUB_ERROR_CODE` that the server or SDK can surface. Each entry lists the **symptom** users see, the **likely cause**, and the **fix** — in that order, because that's the order a developer diagnosing an incident will want them.

```ts
import { OneSubError, ONESUB_ERROR_CODE } from '@jeonghwanko/onesub-sdk';

try { await purchaseProduct(...) } catch (err) {
  if (err instanceof OneSubError) console.log(err.code); // ← look it up below
}
```

The server returns the same codes in response bodies:

```json
{ "valid": false, "error": "...", "errorCode": "NON_CONSUMABLE_ALREADY_OWNED" }
```

If you see `[onesub]` trace logs and want to understand them, enable `config.debug: true` and read [`packages/sdk/README.md#debug-mode`](../packages/sdk/README.md).

---

## How to diagnose quickly

1. **Check `errorCode` first, not `message`.** The message is human-readable (may be localized or truncated). `errorCode` is stable.
2. **Turn on `config.debug`** in dev — every purchase event prints `matched` / `matchingAllowed` / `action`, which narrows the cause in seconds.
3. **Check the server logs** (`[onesub/...]` prefix). Providers tag their own logs: `[onesub/apple]` / `[onesub/google]` / `[onesub/purchase]` / `[onesub/webhook]`.

---

## Input / configuration

### `INVALID_INPUT` (400)

The request body or query failed zod validation — required field missing, wrong type, or exceeds length.

- **Symptom**: any 400 on `POST /onesub/validate`, `POST /onesub/purchase/validate`, `GET /onesub/status`, or admin routes.
- **Fix**: check the `error` string — it contains the zod `issue.message` joined with commas. Common misses: `receipt` missing, `userId` > 256 chars, `type` not one of `consumable`/`non_consumable`.

### `APPLE_CONFIG_MISSING` / `GOOGLE_CONFIG_MISSING` (500)

Request arrived with `platform: 'apple'` but `config.apple` is not set on the server (or same for Google).

- **Symptom**: Apple devices get `APPLE_CONFIG_MISSING`, Android devices work fine (or vice versa).
- **Fix**: set `APPLE_BUNDLE_ID` / `GOOGLE_PACKAGE_NAME` + credentials in the server's `.env` and restart. For app-only testing without real credentials, use SDK `mockMode: true` instead.

### `USER_ID_TOO_LONG` (400)

`userId` query param on `GET /onesub/status` exceeds 256 characters.

- **Fix**: stop sending JWTs/tokens as `userId`. Use a short stable identifier (UUID, numeric ID, device ID).

---

## Receipt validation

### `RECEIPT_VALIDATION_FAILED` (422)

The platform provider (Apple or Google) rejected the receipt. Covers many underlying reasons that the server deliberately groups under one code to avoid leaking store-specific detail.

- **Symptom**: `valid: false, errorCode: 'RECEIPT_VALIDATION_FAILED'` immediately after `purchaseProduct()`.
- **Common causes** (check server logs for the prefix):
  - `[onesub/apple] Bundle ID mismatch: com.other.app !== com.yourapp.id` — product was purchased in a different app
  - `[onesub/apple] Sandbox receipt rejected in production: Sandbox` — TestFlight receipt hitting prod server. Set `ONESUB_ALLOW_SANDBOX=true` env during QA
  - `[onesub/apple] Purchase was revoked/refunded` — user got a refund
  - `[onesub/apple] Consumable receipt too old (>72h)` — security cutoff
  - `[onesub/apple] Product ID mismatch` — `productId` in request doesn't match the JWS transaction
  - `[onesub/google] Play Products API error 401` — service account doesn't have "View financial data" permission (use `playstore_verify_service_account` from [`@yoonion/mimi-seed-mcp`](https://github.com/jeonghwanko/app-gen) to diagnose step-by-step)
  - `[onesub/google] Consumable already consumed — possible replay attack` — token was already consumed (replay)
- **Fix**: match the log line above.

### `NO_RECEIPT_DATA`

- **SDK**: `purchaseUpdatedListener` fired an event with no `purchaseToken` / `transactionReceipt`. This indicates a malformed event from `react-native-iap` v15 or a mock.
- **Server**: `receipt` was empty in the POST body.
- **Fix**: upgrade `react-native-iap` to the latest v15.x and retest. If it persists, enable `debug` and paste the `event received` trace.

---

## Authorization

### `UNAUTHORIZED` (401)

Only fires on `POST /onesub/webhook/google` when `config.google.pushAudience` is set and the Pub/Sub JWT is missing/invalid.

- **Fix**: verify the push endpoint URL in Google Cloud Pub/Sub subscription settings matches exactly the `pushAudience` value (including `https://` and trailing slashes). Or unset `pushAudience` to disable JWT auth on that endpoint (backwards-compatible mode).

### `INVALID_ADMIN_SECRET` (401)

Admin route called without the `X-Admin-Secret` header, or with the wrong value.

- **Fix**: set the header: `curl -H "X-Admin-Secret: $ADMIN_SECRET" ...`. If you're not using admin routes, leave `config.adminSecret` unset — the entire admin router won't mount and calls will return 404 instead.

---

## Ownership / conflict

### `NON_CONSUMABLE_ALREADY_OWNED` (409)

User already owns this non-consumable on the server side (first check, before receipt validation even runs).

- **Symptom**: User taps "Purchase" on a non-consumable they already own; server returns 409 immediately.
- **SDK behavior**: the SDK translates this into `{ valid: true, action: 'restored' }` for user-friendly handling. The 409 + `errorCode` is what non-SDK HTTP clients see.
- **Fix (client UX)**: use `result.action === 'restored'` to show "이미 구매한 상품입니다" instead of "구매 완료". The SDK also auto-fires `finishTransaction` so StoreKit queue stays clean.

### `TRANSACTION_BELONGS_TO_OTHER_USER` (409)

Same `transactionId` was first seen under a different `userId`, and this is a **consumable** purchase (for non-consumables, 0.6.1+ auto-reassigns silently).

- **Symptom**: user gets 409 on consumable purchase, server logs show the same `transactionId` was already used by another account.
- **Common cause**: an attacker trying to replay a receipt from one account onto another, OR a legitimate user whose device migrated in a way the SDK can't auto-resolve.
- **Fix**: legitimate migration path → call `POST /onesub/purchase/admin/transfer` with admin secret. Fraud → block the account.

### `TRANSACTION_NOT_FOUND` (404)

Only fires on `POST /onesub/purchase/admin/transfer` when the supplied `transactionId` has no corresponding row.

- **Fix**: double-check the `transactionId` value. Transaction IDs are case-sensitive and full-length.

---

## Webhook-specific

### `MISSING_SIGNED_PAYLOAD` / `INVALID_SIGNED_PAYLOAD` (400)

Apple's App Store Server Notifications V2 sends `{ signedPayload: '<JWS>' }`. Missing or non-JWS value.

- **Common causes**: App Store Connect misconfigured to use the V1 format; Apple's staging webhook hitting your endpoint with a test payload.
- **Fix**: in App Store Connect → App → App Information → App Store Server Notifications → ensure **Version 2** is selected. Pre-decoded webhook path has been intentionally removed for security.

### `MISSING_MESSAGE_DATA` (400)

Google Pub/Sub RTDN body is missing `message.data`. The endpoint expects a standard Pub/Sub push message shape `{ message: { data: '<base64>', messageId }, subscription }`.

- **Fix**: verify the Pub/Sub subscription type is **Push** (not Pull), and the push endpoint URL is `https://.../onesub/webhook/google`.

### `PACKAGE_NAME_MISMATCH` (400)

RTDN notification's `packageName` does not match `config.google.packageName`.

- **Common cause**: two apps sharing one Google Cloud project; one app's Pub/Sub is routing to the other's onesub server.
- **Fix**: verify `config.google.packageName` on the server matches `android/app/build.gradle` `applicationId`.

---

## Server internal

### `INTERNAL_ERROR` (500)

Catch-all for unexpected exceptions in route handlers.

- **Fix**: check server logs for the stack trace. Most likely causes: upstream Apple/Google API timeout, JSON parse error, broken Promise chain.

### `STORE_ERROR` (500)

The underlying `SubscriptionStore` / `PurchaseStore` threw — usually Postgres down, connection pool exhausted, or a missing table.

- **Fix (first time)**: verify the canonical schema is applied. Either `store.initSchema()` at boot, or `psql -f node_modules/@onesub/server/sql/schema.sql`.
- **Fix (intermittent)**: Postgres connection limit. Scale up, or use PgBouncer.

### `WEBHOOK_PROCESSING_FAILED` (500)

Webhook handler threw AFTER signature verification succeeded (i.e., the JWS/JWT was valid, but downstream store.save or provider re-fetch failed).

- **Retry policy**: Apple (5 retries, ~3 days) and Google (Pub/Sub default, up to 7 days) will retry automatically. Check logs for the stack trace and fix the root cause — don't disable the 500 to silence them.

---

## SDK client

### `NOT_IN_PROVIDER`

`useOneSub()` was called outside `<OneSubProvider>`.

- **Fix**: wrap the relevant part of the tree:
  ```tsx
  <OneSubProvider config={...} userId={...}>
    <ChildThatCallsUseOneSub />
  </OneSubProvider>
  ```

### `RN_IAP_NOT_INSTALLED`

The SDK's optional peer dep `react-native-iap` isn't resolvable at runtime.

- **Fix**: `npm install react-native-iap@^15`. For Expo Go testing without the native module, set `config.mockMode: true`.

### `PRODUCT_NOT_FOUND`

`RNIap.fetchProducts` returned an empty array for the given SKU.

- **Common causes**:
  - Product not submitted / approved on App Store Connect or Google Play Console
  - Bundle ID / package name mismatch between app and store listing
  - Product is for a different region than the tester's account
  - Apple sandbox: first call after paid Apple Developer agreement change can fail; retry after 5 minutes
- **Fix**: verify the SKU appears on the store dashboard under the same bundle/package.

### `PURCHASE_TIMEOUT`

SDK waited 180 seconds for `purchaseUpdatedListener` to fire after `requestPurchase()` was called.

- **Common causes**: user dismissed the sheet in a way that didn't trigger `purchaseErrorListener` (rare); network stall between Apple/Google and device; drain window never closed due to `initConnection` failure.
- **Fix**: enable `debug`. If the `[onesub] listeners attached; drain window open` trace fires but no `event received` follows, the issue is the native layer — usually a reboot / reinstall resolves.

### `USER_CANCELLED`

User dismissed the StoreKit / Play sheet. Not an error — handle silently.

- **SDK behavior**: `purchaseProduct()` returns `null`, `subscribe()` returns (void). This code is used internally when the promise is rejected by the error listener.

### `CONCURRENT_PURCHASE`

`subscribe()` / `purchaseProduct()` for the same `productId` called while a previous call for that same `productId` hasn't resolved yet.

- **Fix (client)**: gate the buy button on `isLoading`. The SDK already protects with `isBusyRef` at the session level, but concurrent calls for different `productId`s via separate code paths can still race.

### `PROVIDER_UNMOUNTED`

The `<OneSubProvider>` unmounted while a purchase was in flight. Any pending `purchaseProduct()` promise is rejected with this code.

- **Common cause**: navigation / route change during purchase.
- **Fix (client)**: don't unmount the Provider. Keep it at the root of the tree.

### `NETWORK_ERROR`

Thrown from `api.ts` helpers when `fetch()` rejects (offline, DNS failure, TLS error).

- **Fix (client)**: show "네트워크 상태를 확인해주세요" alert + retry. The server never surfaces this — it's purely client-side.

---

## Client error-handling template

Copy-paste as your baseline:

```ts
import { OneSubError, ONESUB_ERROR_CODE } from '@jeonghwanko/onesub-sdk';

try {
  const result = await purchaseProduct(productId, 'non_consumable');
  if (!result) return; // user cancelled or provider unmounted
  if (result.action === 'restored') {
    Alert.alert('이미 구매한 상품입니다', '이전 구매 내역이 복원되었어요.');
  } else {
    Alert.alert('구매 완료!', '프리미엄이 활성화되었습니다.');
  }
} catch (err) {
  if (!(err instanceof OneSubError)) { throw err; }
  switch (err.code) {
    case ONESUB_ERROR_CODE.USER_CANCELLED: return;
    case ONESUB_ERROR_CODE.CONCURRENT_PURCHASE: return; // double-tap
    case ONESUB_ERROR_CODE.NETWORK_ERROR:
    case ONESUB_ERROR_CODE.PURCHASE_TIMEOUT:
      return Alert.alert('네트워크 상태를 확인해주세요.');
    case ONESUB_ERROR_CODE.PRODUCT_NOT_FOUND:
      return Alert.alert('상품을 찾을 수 없습니다.');
    case ONESUB_ERROR_CODE.NON_CONSUMABLE_ALREADY_OWNED:
      return Alert.alert('이미 구매한 상품입니다.');
    default:
      return Alert.alert('결제 실패', err.message);
  }
}
```

Also see [`packages/sdk/README.md`](../packages/sdk/README.md) for the full client API.
