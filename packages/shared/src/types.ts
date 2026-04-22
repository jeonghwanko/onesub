import type { OneSubErrorCode } from './constants.js';

/** Subscription status */
export type SubscriptionStatus = 'active' | 'expired' | 'canceled' | 'none';

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
  };
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
