# Migrating from RevenueCat to onesub

A pragmatic guide for teams switching from RevenueCat (RC) to onesub — covering client code, server setup, historical data, webhook switchover, and rollback.

> **TL;DR**: onesub handles the same receipt-validation + subscription-tracking problem as RC, minus the dashboard and analytics, plus full data ownership and zero revenue share. The switchover is doable in a day for small apps if your entitlements are simple.

---

## Feature parity table

| RevenueCat | onesub | Notes |
|---|---|---|
| `Purchases.configure({ apiKey, appUserID })` | `<OneSubProvider config={...} userId={...} />` | `userId` replaces `appUserID` |
| `Purchases.getCustomerInfo()` | `useOneSub().isActive` + `GET /onesub/status` + `GET /onesub/purchase/status` | RC bundles everything; onesub splits subscriptions and one-time purchases |
| `Purchases.purchasePackage()` | `useOneSub().subscribe()` | For subscriptions |
| `Purchases.purchaseProduct()` | `useOneSub().purchaseProduct(id, type)` | For consumables / non-consumables |
| `Purchases.restorePurchases()` | `useOneSub().restore()` + `restoreProduct(id, type)` | Separate per product type |
| `PurchasesDelegate.purchases(didUpdate:)` | Automatic — `OneSubProvider` attaches a mount-level listener | onesub handles StoreKit queue automatically; no delegate needed |
| `EntitlementInfo` | `SubscriptionInfo` + `PurchaseInfo` | Direct shape, no entitlements layer |
| `Offering` / `Package` | **none** — use raw `productId` strings | Model store offerings in your app layer if needed |
| RC Paywall Builder | `<Paywall />` component (basic) | onesub's paywall is minimal — build your own or keep RC's paywall code |
| RC Dashboard (MRR, cohorts) | **none** | Roll your own from `onesub_subscriptions` / `onesub_purchases` tables |
| Apple/Google webhooks | `POST /onesub/webhook/apple` + `POST /onesub/webhook/google` | You point stores directly at your server |
| RC data export | `pg_dump onesub_subscriptions` | It's your DB |
| Revenue share | 0% | RC: 1% above $2.5K MRR |

---

## Pre-migration checklist

Stop here and confirm each item. Migrations that skip these bite hardest 2 weeks later.

- [ ] **Apple credentials**: App-Specific Shared Secret from App Store Connect → Apps → App Information → App-Specific Shared Secret. You'll set `APPLE_SHARED_SECRET`.
- [ ] **Google credentials**: Service Account JSON with "View financial data" permission. You'll set `GOOGLE_SERVICE_ACCOUNT_KEY`. *(Tip: [`@yoonion/mimi-seed-mcp`](https://github.com/jeonghwanko/app-gen) — `iam_create_service_account` → `iam_create_key` → `playstore_verify_service_account` 3-step automation from Claude CLI)*
- [ ] **Bundle ID / package name** for both platforms. `config.apple.bundleId` and `config.google.packageName` must match exactly.
- [ ] **Postgres** (>= 12) or your own `SubscriptionStore` / `PurchaseStore` implementation.
- [ ] **A server host** with a public HTTPS URL — Apple and Google require TLS.
- [ ] **TestFlight + Play Internal Testing track** access for smoke tests before cutover.
- [ ] **An RC snapshot** of current active entitlements (RC REST API `/v1/subscribers/{appUserID}` or data export) in case you need to reconcile later.

---

## Step 1. Stand up onesub

Fastest path: scaffold with `@onesub/cli`.

```bash
npx @onesub/cli init my-onesub-server
cd my-onesub-server
cp .env.example .env   # fill in APPLE_/GOOGLE_ credentials + DATABASE_URL
npm install
docker compose up -d db    # Postgres with schema auto-init
npm run dev
curl http://localhost:4100/health
```

Then deploy to your host (Fly / Render / Railway / your Kubernetes cluster). You need an HTTPS URL before the next step.

See [`packages/server/README.md`](../packages/server/README.md) for alternative hosting paths.

---

## Step 2. Migrate client code

### Install

```bash
npm uninstall react-native-purchases react-native-purchases-ui
npm install @jeonghwanko/onesub-sdk react-native-iap
# If you were using RC's paywall builder, keep your own paywall component or use the minimal one onesub ships.
```

### Provider setup

Before (RC):
```tsx
import Purchases from 'react-native-purchases';

useEffect(() => {
  Purchases.configure({ apiKey: 'rc_xxx', appUserID: userId });
}, [userId]);
```

After (onesub):
```tsx
import { OneSubProvider } from '@jeonghwanko/onesub-sdk';

<OneSubProvider
  config={{ serverUrl: 'https://api.yourapp.com', productId: 'pro_monthly', debug: __DEV__ }}
  userId={userId}
>
  <App />
</OneSubProvider>
```

### Subscriptions

Before:
```tsx
const offerings = await Purchases.getOfferings();
const pkg = offerings.current?.availablePackages[0];
if (pkg) {
  const { customerInfo } = await Purchases.purchasePackage(pkg);
  if (customerInfo.entitlements.active['pro']) { /* ok */ }
}
```

After:
```tsx
const { subscribe, isActive } = useOneSub();
await subscribe(); // throws OneSubError on failure, null on cancel
if (isActive) { /* ok */ }
```

### One-time purchases

Before:
```tsx
await Purchases.purchaseStoreProduct(product);
const { customerInfo } = await Purchases.getCustomerInfo();
const owns = customerInfo.nonSubscriptionTransactions.some(t => t.productIdentifier === 'premium');
```

After:
```tsx
const { purchaseProduct } = useOneSub();
const result = await purchaseProduct('premium', 'non_consumable');
if (result?.action === 'restored') { /* already owned */ }
if (result?.action === 'new') { /* fresh purchase */ }
```

### Restore

Before: `await Purchases.restorePurchases()`
After:  `await restore()` (subscription) **or** `await restoreProduct('premium', 'non_consumable')` (one-time)

### Error handling

Before:
```ts
if (error.userCancelled) return;
```

After — use `OneSubError` with canonical codes. See [`docs/RECEIPT-ERRORS.md`](RECEIPT-ERRORS.md) for the full catalog. Minimal handler:

```tsx
import { OneSubError, ONESUB_ERROR_CODE } from '@jeonghwanko/onesub-sdk';

try {
  await purchaseProduct('premium', 'non_consumable');
} catch (err) {
  if (err instanceof OneSubError && err.code === ONESUB_ERROR_CODE.USER_CANCELLED) return;
  // handle others
}
```

---

## Step 3. Migrate historical purchase data

Three strategies — pick based on risk tolerance.

### Option A (recommended for most apps): Lazy migration via StoreKit replay

**How it works.** Don't export anything. Ship the new client + server. When each user next opens the app, StoreKit / Play Billing replay their existing transactions to the SDK's `purchaseUpdatedListener`. onesub validates them fresh against Apple/Google and inserts into `onesub_subscriptions` / `onesub_purchases`. The server's idempotent `action: 'restored'` response means no double-grant.

**Pros**: zero data pipeline, zero API keys to exchange, works even if RC is already offline.

**Cons**: entitlement appears missing for users between "app open after migration" and "replay completes" — usually seconds. Call `checkStatus` / `checkPurchaseStatus` on app mount to trigger the server sync, or show a loading state on your paywall until `isActive` resolves.

**Recommended if**: < 100K users, no custom grants (promo codes), simple subscription model.

### Option B: Export from RC + bulk grant via admin route

Use RC's REST API to pull active entitlements, then POST to onesub's admin grant route for each.

```bash
# Export subscribers from RC (loop through all users)
curl https://api.revenuecat.com/v1/subscribers/{appUserID} \
  -H "Authorization: Bearer $RC_SECRET_KEY"

# For each user with an active non-consumable entitlement:
curl -X POST https://api.yourapp.com/onesub/purchase/admin/grant \
  -H "X-Admin-Secret: $ADMIN_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"userId":"user_123","productId":"premium","platform":"apple","type":"non_consumable","transactionId":"original_transaction_id_from_rc"}'
```

**Pros**: users see entitlements instantly on first app open — no "missing subscription" flicker. Preserves your grant history (promo codes, compensation grants) that Apple/Google don't know about.

**Cons**: requires ADMIN_SECRET to be set on server; you're writing a one-shot migration script; RC API rate limits apply (typically 60 req/min).

**Recommended if**: you have non-store grants (promo / gift / compensation), or you want zero entitlement downtime.

### Option C: Dual-run for a transition period

Ship the new client (onesub) pointed at your new server. Keep RC running in parallel — your app reads entitlement from **both** (`RC customerInfo || onesub isActive`) and purchases only write to onesub. After 30 days (or whenever RC entitlement check rate drops below your threshold), disconnect RC.

**Pros**: safe fallback — if onesub has a bug, RC catches it for existing users.

**Cons**: double SDK bundle size, complex client logic, you pay RC for another month.

**Recommended if**: you're risk-averse and your subscription revenue is large enough that a 1-day outage would hurt.

---

## Step 4. Switch webhooks (most delicate)

RC listens to Apple/Google webhooks on their infrastructure and relays relevant ones to your app. When you cut over, Apple/Google must send them directly to onesub.

### Apple

1. App Store Connect → your app → **App Information** → **App Store Server Notifications** (bottom of page)
2. Change **Production URL** from RC's URL to `https://api.yourapp.com/onesub/webhook/apple`
3. Also update **Sandbox URL** if used
4. Ensure **Version 2** is selected
5. Send a Test Notification from App Store Connect — confirm your server logs show `[onesub/webhook/apple] Received notification for unknown transaction` (normal — it's a test tx that isn't in your DB yet)

### Google

1. Google Play Console → your app → **Monetize** → **Monetization setup** → **Real-time developer notifications**
2. Update **Topic name** to a Pub/Sub topic you own (not RC's)
3. Create a Pub/Sub **Push subscription** on that topic, with endpoint `https://api.yourapp.com/onesub/webhook/google`
4. Under the subscription, **Enable authentication** and set the audience to the same URL. Set onesub's `config.google.pushAudience` accordingly
5. Send a Test Publish to the topic — confirm your server's `[onesub/webhook/google]` logs fire

### Cutover timing

The safest window:
- **Before cutover**: ensure all future Apple/Google notifications between now and the flip are acceptable to lose (renewals that fire during the gap will eventually re-sync via StoreKit replay on the user's next app open).
- **Flip both URLs at the same time**. Don't leave one side on RC.
- **Verify webhook receipt in logs** within 5 minutes. If silent, Google's push subscription authentication is the most common gotcha.

---

## Step 5. Verification checklist

Before you tell the team the migration is done:

- [ ] TestFlight sandbox purchase on iOS → `action: 'new'` in logs, `isActive: true` on SDK side, row in `onesub_subscriptions`
- [ ] Internal track purchase on Android → same checks
- [ ] Restore on iOS → `action: 'restored'` → entitlement restored, no double grant
- [ ] Apple webhook test notification → server logs `[onesub/webhook/apple]` 200 response
- [ ] Google Pub/Sub test publish → server logs `[onesub/webhook/google]` 200 response
- [ ] SQL check: `SELECT count(*) FROM onesub_subscriptions WHERE status = 'active'` is >= expected
- [ ] Spot-check 3 users from RC's data → they appear in onesub with `status = 'active'` (either via lazy replay on re-open or Option B bulk-grant)
- [ ] Production smoke: one real Apple ID buys one real product, Apple webhook fires within 1 min, DB row created

---

## Rollback plan

If onesub misbehaves in production, you revert in two steps:

1. **Stop new writes**: point Apple / Google webhooks back to RC. RC remembers configurations for 30 days.
2. **Restore client**: publish an app build with RC SDK re-integrated. Existing onesub server keeps running in read-only mode (its DB preserves whatever state it collected).

You can then cherry-pick the onesub data back to RC by POSTing to RC's REST API per-user. Painful but possible.

Practical advice: keep **RC webhooks enabled for 72 hours** after cutover so you have a re-source of truth if anything drifts.

---

## Feature parity gaps (honest list)

onesub deliberately doesn't implement a few RC features. If any of these are hard requirements, either delay the migration or plan to build them.

- **Offerings / Packages / experiments**: RC models "which products to show" as first-class. In onesub, that's your app's job — use remote config, A/B tool, or hardcoded arrays.
- **Cohort analytics, LTV, churn dashboards**: zero. You have SQL.
- **Attribution** (install referrer, ad-network integration): none. Use a separate attribution SDK (AppsFlyer, Adjust).
- **Paywall builder / remote paywall config**: the `<Paywall />` component is minimal. For A/B-testable paywalls use your existing solution.
- **Promotional offers UX**: supported at the raw receipt-validation level, but onesub doesn't expose a higher-level helper. You handle `introPrice` / `promotionalOffer` in your client logic.
- **Customer support**: RC has a dashboard for refunds / subscription management. onesub's admin routes (`/onesub/purchase/admin/*`) cover manual grants and transfers but not the "fix a customer's problem" flow. Build a thin admin UI if you need one.

---

## Getting help

- **Error debugging**: enable `config.debug: true` and check [`docs/RECEIPT-ERRORS.md`](RECEIPT-ERRORS.md)
- **Security model**: [`docs/SECURITY.md`](SECURITY.md)
- **Breaking changes**: [`docs/MIGRATION.md`](MIGRATION.md)
- **Open issues** (non-security): <https://github.com/jeonghwanko/onesub/issues>
- **Security reports**: [GitHub Security Advisories](https://github.com/jeonghwanko/onesub/security/advisories/new)
