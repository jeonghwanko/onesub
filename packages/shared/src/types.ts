import type { OneSubErrorCode } from './constants.js';

/** Subscription status.
 *
 * Lifecycle states:
 *   - active        — paid period, entitlement valid
 *   - grace_period  — payment failed but Apple/Google grants temporary access
 *                     while retrying. Treat as entitled.
 *   - on_hold       — payment failed, retry window expired or grace ended.
 *                     Entitlement REVOKED until the user fixes payment.
 *                     (Apple "billing retry"; Google "on hold".)
 *   - paused        — user voluntarily paused the subscription (Google only).
 *                     Entitlement REVOKED until autoResumeTime or user resumes.
 *                     Distinct from on_hold: paused is intentional, not a
 *                     payment failure. UX should say "재개 예정" not
 *                     "결제 정보를 업데이트하세요".
 *   - expired       — subscription ended without renewal
 *   - canceled      — refunded or revoked by store
 *   - none          — no record
 */
export type SubscriptionStatus =
  | 'active'
  | 'grace_period'
  | 'on_hold'
  | 'paused'
  | 'expired'
  | 'canceled'
  | 'none';

/** Store platform */
export type Platform = 'apple' | 'google';

/** Receipt validation request */
export interface ValidateReceiptRequest {
  platform: Platform;
  receipt: string;
  userId: string;
  productId: string;
}

/** Receipt validation response */
export interface ValidateReceiptResponse {
  valid: boolean;
  subscription: SubscriptionInfo | null;
  /** Human-readable error. For programmatic handling use `errorCode`. */
  error?: string;
  /** Machine-readable canonical error code. */
  errorCode?: OneSubErrorCode;
}

/** Subscription info returned by server */
export interface SubscriptionInfo {
  userId: string;
  productId: string;
  platform: Platform;
  status: SubscriptionStatus;
  expiresAt: string;
  originalTransactionId: string;
  purchasedAt: string;
  willRenew: boolean;
  /**
   * Google-only. The previous purchaseToken in an upgrade/downgrade/replace
   * chain — set when this subscription was started by replacing another one.
   * Lets the host follow user identity across plan changes (Google issues a
   * new token per plan change). Null/undefined for first-purchase or Apple.
   */
  linkedPurchaseToken?: string;
  /**
   * Google-only. When `status === 'paused'`, the RFC3339 timestamp at which
   * Google plans to auto-resume the subscription (from
   * `pausedStateContext.autoResumeTime` in subscriptionsv2). Lets the host UX
   * show "재개 예정: YYYY-MM-DD" instead of just "일시정지 중". Undefined when
   * not paused or if Google didn't supply it.
   */
  autoResumeTime?: string;
}

/** Subscription status check response */
export interface StatusResponse {
  active: boolean;
  subscription: SubscriptionInfo | null;
  error?: string;
  errorCode?: OneSubErrorCode;
}

/** Apple Server Notification V2 */
export interface AppleNotificationPayload {
  notificationType: string;
  subtype?: string;
  data: {
    signedTransactionInfo: string;
    signedRenewalInfo: string;
    environment?: string;  // 'Production' | 'Sandbox'
    bundleId?: string;
  };
}

/**
 * Apple App Store Server API ConsumptionRequest body — the response Apple
 * expects when it sends a CONSUMPTION_REQUEST notification asking whether to
 * grant or decline a consumable refund.
 *
 * https://developer.apple.com/documentation/appstoreserverapi/consumptionrequest
 */
export interface AppleConsumptionRequest {
  /** REQUIRED — must be true; if false, Apple ignores the response. */
  customerConsented: boolean;
  /** 0 = undeclared, 1 = not consumed, 2 = partially consumed, 3 = fully consumed */
  consumptionStatus: 0 | 1 | 2 | 3;
  /** 0 = undeclared, 1 = delivered & working, 2 = quality issue, 3 = wrong item, 4 = server outage, 5 = currency change */
  deliveryStatus: 0 | 1 | 2 | 3 | 4 | 5;
  /** 0 = undeclared, 1 = grant refund, 2 = decline, 3 = no preference */
  refundPreference?: 0 | 1 | 2 | 3;
  /** 0 = undeclared, 1 = active, 2 = suspended, 3 = terminated, 4 = limited */
  userStatus?: 0 | 1 | 2 | 3 | 4;
  /** 0 = undeclared, 1 = <3 days, 2 = 3-10d, 3 = 10-30d, 4 = 30-90d, 5 = >90d */
  accountTenure?: 0 | 1 | 2 | 3 | 4 | 5;
  /** 0 = undeclared, 1 = <5min, 2 = 5-60min, 3 = 1-6h, 4 = 6-24h, 5 = 1-4d, 6 = >4d */
  playTime?: 0 | 1 | 2 | 3 | 4 | 5 | 6;
  /** 0 = undeclared, 1 = $0, 2 = $0.01-$49.99, ... 7 = >$1999.99 */
  lifetimeDollarsPurchased?: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;
  /** Same buckets as lifetimeDollarsPurchased */
  lifetimeDollarsRefunded?: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;
  /** 0 = undeclared, 1 = Apple, 2 = Non-Apple */
  platform?: 0 | 1 | 2;
  sampleContentProvided?: boolean;
  /** UUID — same value the client passed via setAppAccountToken */
  appAccountToken?: string;
}

/** Context passed to the consumptionInfoProvider hook for a CONSUMPTION_REQUEST notification. */
export interface AppleConsumptionContext {
  transactionId: string;
  originalTransactionId: string;
  productId: string;
  bundleId: string;
  environment: 'Production' | 'Sandbox';
}

/** Context passed to the Google onPriceChangeConfirmed hook. */
export interface GooglePriceChangeContext {
  /** purchaseToken — the same id stored as originalTransactionId for Google subs. */
  purchaseToken: string;
  /** Subscription productId (Google: subscriptionId). */
  subscriptionId: string;
  packageName: string;
}

/** Google RTDN (Real-Time Developer Notification) */
export interface GoogleNotificationPayload {
  message: {
    data: string; // base64 encoded
    messageId: string;
  };
  subscription: string;
}

/**
 * Structured logger interface — compatible with the common shape of
 * `pino`, `winston`, `bunyan`, and `console`. Pass your own implementation
 * via `OneSubServerConfig.logger` to redirect onesub's runtime logs.
 *
 * Default: `console` (when `logger` is omitted).
 */
export interface OneSubLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

/** Server config */
export interface OneSubServerConfig {
  apple?: {
    bundleId: string;
    sharedSecret?: string;
    keyId?: string;
    issuerId?: string;
    privateKey?: string;
    /** Skip JWS signature verification (for development/testing only) */
    skipJwsVerification?: boolean;
    /**
     * Mock provider mode — when true, bypass all Apple API calls and decide
     * receipt validity from the receipt string pattern (see `providers/mock.ts`).
     * Use for local development, CI, and AI-driven integration testing without
     * real App Store Connect credentials. **NEVER enable in production.**
     */
    mockMode?: boolean;
    /**
     * Hook to provide consumption info when Apple sends a CONSUMPTION_REQUEST
     * notification (consumable refund review).
     *
     * If set, the webhook handler calls this with the refunded transaction's
     * context and PUTs the returned ConsumptionRequest to Apple's
     * /inApps/v1/transactions/consumption/{txId} endpoint. Without this hook,
     * Apple has no usage signal and tends to grant the refund.
     *
     * Requires keyId, issuerId, and privateKey to be configured (the API call
     * is JWT-authenticated). Return null to skip this particular request.
     */
    consumptionInfoProvider?: (
      ctx: AppleConsumptionContext,
    ) => Promise<AppleConsumptionRequest | null>;
  };
  google?: {
    packageName: string;
    serviceAccountKey?: string;
    /**
     * Expected `aud` claim for incoming Pub/Sub push JWT tokens.
     * When set, the Google webhook endpoint verifies the `Authorization: Bearer <token>`
     * header as a Google-signed JWT whose `aud` matches this value.
     * If omitted, no authentication is performed on the webhook (backward compatible).
     *
     * Set this to the push endpoint URL registered in your Pub/Sub subscription,
     * e.g. `https://your-server.example.com/onesub/webhook/google`.
     */
    pushAudience?: string;
    /**
     * Mock provider mode — same as `apple.mockMode` but for Google Play.
     * Bypass Play Developer API calls and decide receipt validity from the
     * receipt string pattern. **NEVER enable in production.**
     */
    mockMode?: boolean;
    /**
     * Called when a SUBSCRIPTION_PRICE_CHANGE_CONFIRMED RTDN arrives — the
     * user has agreed to the price change and the new price applies on the
     * next renewal. Useful for analytics / in-app notifications / audit logs.
     *
     * Fire-and-forget: failures are logged, never thrown — the webhook still
     * 200s. Receives only the routing context; for the actual new price,
     * call purchases.subscriptionsv2 directly (the lineItem's
     * autoRenewingPlan.priceChangeDetails carries newPrice + chargeTime).
     */
    onPriceChangeConfirmed?: (ctx: GooglePriceChangeContext) => void | Promise<void>;
  };
  database: {
    url: string;
  };
  webhookSecret?: string;
  /**
   * Shared secret required for admin endpoints (purchase reset / manual grant).
   * If set, admin routes are enabled and require the `X-Admin-Secret` header
   * to match. If unset, admin routes return 404.
   */
  adminSecret?: string;
  /**
   * Structured logger to receive onesub's runtime logs. If omitted, logs go
   * to `console.info/warn/error`. Any object that implements `OneSubLogger`
   * (`pino`, `winston`, `bunyan`, `console`) works.
   */
  logger?: OneSubLogger;
  /**
   * How to handle subscription refunds (Apple REFUND/REVOKE, Google
   * voidedPurchaseNotification productType=1).
   *
   * - `'immediate'` (default): mark `status` as `canceled` right away. The
   *   user loses entitlement immediately on the next /onesub/status check.
   *   Strict, fraud-resistant.
   *
   * - `'until_expiry'`: keep `status` and `expiresAt` untouched, only flip
   *   `willRenew` to `false`. The user keeps entitlement until the original
   *   expiry passes (status route's stale-record check then drops them
   *   automatically). Better UX for goodwill refunds; heavier on fraud risk.
   *
   * One-time purchases (consumable / non-consumable) are NOT affected by
   * this setting — those always revoke immediately on refund because they
   * have no expiry concept.
   */
  refundPolicy?: 'immediate' | 'until_expiry';
}

/** Purchase type */
export type PurchaseType = 'consumable' | 'non_consumable' | 'subscription';

/** One-time purchase info (consumable or non-consumable) */
export interface PurchaseInfo {
  userId: string;
  productId: string;
  platform: Platform;
  type: PurchaseType;
  transactionId: string;
  purchasedAt: string;
  quantity: number; // 1 for non-consumable, 1+ for consumable
}

/** Purchase validation request */
export interface ValidatePurchaseRequest {
  platform: Platform;
  receipt: string;
  userId: string;
  productId: string;
  type: PurchaseType;
}

/** Purchase validation response */
export interface ValidatePurchaseResponse {
  valid: boolean;
  purchase: PurchaseInfo | null;
  /** Human-readable error. For programmatic handling use `errorCode`. */
  error?: string;
  /** Machine-readable canonical error code. */
  errorCode?: OneSubErrorCode;
  /**
   * Present on `valid: true` only:
   * - 'new'      — freshly inserted (first time this transactionId seen)
   * - 'restored' — transactionId already existed (idempotent or reassigned)
   *                use this to show "복원됨" instead of "구매 완료".
   */
  action?: 'new' | 'restored';
}

/** Purchase status response */
export interface PurchaseStatusResponse {
  purchases: PurchaseInfo[];
  error?: string;
  errorCode?: OneSubErrorCode;
}

/** SDK config (client-side) */
export interface OneSubConfig {
  serverUrl: string;
  productId: string;
  /** Apple product ID (defaults to productId) */
  appleProductId?: string;
  /** Google product ID (defaults to productId) */
  googleProductId?: string;
  /**
   * Mock mode — when true, purchase/subscribe/restore return synthetic
   * success responses without calling react-native-iap or the server.
   * Useful for local UI development in Expo Go or simulators without
   * configured store credentials. NEVER enable in production builds.
   */
  mockMode?: boolean;
  /**
   * When true, the SDK emits verbose `[onesub]` traces at every step of the
   * purchase lifecycle: IAP connection, listener events with productId and
   * transactionId, in-flight matches, server validations, finishTransaction
   * calls, and drain-window transitions. Recommended while debugging an
   * integration; leave unset (falsy) in production.
   */
  debug?: boolean;
  /**
   * Structured logger for SDK logs. If omitted, logs go to `console`. Any
   * object with `{ info, warn, error }` works (`pino`, `winston`, `console`,
   * or a custom sink). `debug` traces always route through the same logger.
   */
  logger?: OneSubLogger;
}

/** Paywall config */
export interface PaywallConfig {
  title: string;
  subtitle?: string;
  features: string[];
  price: string;
  ctaText: string;
  /** Restore button text */
  restoreText?: string;
}
