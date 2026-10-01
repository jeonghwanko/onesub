# @onesub/shared

Shared TypeScript types + constants used by [`@onesub/server`](https://www.npmjs.com/package/@onesub/server), [`@jeonghwanko/onesub-sdk`](https://www.npmjs.com/package/@jeonghwanko/onesub-sdk), and [`@onesub/mcp-server`](https://www.npmjs.com/package/@onesub/mcp-server).

You don't install this package directly — it's pulled in as a transitive dependency. But if you're writing your own client or store implementation, here's what's exposed:

```ts
import {
  // Core types
  OneSubServerConfig,
  OneSubLogger,
  SubscriptionInfo,           // includes optional linkedPurchaseToken + autoResumeTime (Google)
  PurchaseInfo,
  ValidateReceiptRequest,
  ValidateReceiptResponse,
  ValidatePurchaseRequest,
  ValidatePurchaseResponse,
  PurchaseStatusResponse,
  AppleNotificationPayload,
  GoogleNotificationPayload,

  // Apple App Store Server API hook types
  AppleConsumptionRequest,    // body shape for PUT /inApps/v1/transactions/consumption/{txId}
  AppleConsumptionContext,    // arg passed to apple.consumptionInfoProvider hook

  // Google RTDN hook types
  GooglePriceChangeContext,   // arg passed to google.onPriceChangeConfirmed hook

  // Constants
  SUBSCRIPTION_STATUS,   // 'active' | 'grace_period' | 'on_hold' | 'paused' | 'expired' | 'canceled' | 'none'
  PURCHASE_TYPE,          // 'consumable' | 'non_consumable' | 'subscription'
  ROUTES,                 // canonical route path constants
  DEFAULT_PORT,
} from '@onesub/shared';
```

### Lifecycle states (since 0.4.0)

| Value | Entitlement | When |
|-------|------------|------|
| `active` | ✅ valid | paid period |
| `grace_period` | ✅ valid | payment failed but Apple/Google grants temporary access (Apple `DID_FAIL_TO_RENEW` + `GRACE_PERIOD` subtype, Google `IN_GRACE_PERIOD`) |
| `on_hold` | ❌ revoked | grace ended; billing retry continues; user must fix payment |
| `paused` | ❌ revoked | user-voluntary pause (Google only); resumes at `autoResumeTime` |
| `expired` | ❌ revoked | natural end without renewal |
| `canceled` | ❌ revoked | refunded or revoked by store |
| `none` | ❌ revoked | no record |

`active` is `isSubscriptionEntitled(sub)`, exported from this package: `(status === 'active' || status === 'grace_period') && max(expiresAt, gracePeriodExpiresAt) > now`. The server's status route, entitlements and metrics all use it, and so can a host. The status route evaluates every subscription the user has and reports the most recent one that grants access. During an Apple grace period `gracePeriodExpiresAt` holds the grace end; `expiresAt` always stays the paid-period end. Hosts that branch on the raw `status` string get the full granularity above (e.g. `paused` → "재개 예정" UX, `on_hold` → "결제 정보 업데이트" UX).

All type definitions are single-source-of-truth. Don't re-declare them in consuming packages — derive from these.

## Links

- Repo: <https://github.com/jeonghwanko/onesub>

MIT © onesub contributors.
