# @onesub/shared

Shared TypeScript types + constants used by [`@onesub/server`](https://www.npmjs.com/package/@onesub/server), [`@jeonghwanko/onesub-sdk`](https://www.npmjs.com/package/@jeonghwanko/onesub-sdk), and [`@onesub/mcp-server`](https://www.npmjs.com/package/@onesub/mcp-server).

You don't install this package directly — it's pulled in as a transitive dependency. But if you're writing your own client or store implementation, here's what's exposed:

```ts
import {
  // Types
  OneSubServerConfig,
  OneSubLogger,
  SubscriptionInfo,
  PurchaseInfo,
  ValidateReceiptRequest,
  ValidateReceiptResponse,
  ValidatePurchaseRequest,
  ValidatePurchaseResponse,
  PurchaseStatusResponse,
  AppleNotificationPayload,
  GoogleNotificationPayload,

  // Constants
  SUBSCRIPTION_STATUS,   // 'active' | 'expired' | 'canceled' | 'none'
  PURCHASE_TYPE,          // 'consumable' | 'non_consumable' | 'subscription'
  ROUTES,                 // canonical route path constants
  DEFAULT_PORT,
} from '@onesub/shared';
```

All type definitions are single-source-of-truth. Don't re-declare them in consuming packages — derive from these.

## Links

- Repo: <https://github.com/jeonghwanko/onesub>

MIT © onesub contributors.
