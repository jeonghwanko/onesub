/** API route paths */
export const ROUTES = {
  VALIDATE: '/onesub/validate',
  STATUS: '/onesub/status',
  WEBHOOK_APPLE: '/onesub/webhook/apple',
  WEBHOOK_GOOGLE: '/onesub/webhook/google',
  VALIDATE_PURCHASE: '/onesub/purchase/validate',
  PURCHASE_STATUS: '/onesub/purchase/status',
  ENTITLEMENT: '/onesub/entitlement',
  ENTITLEMENTS: '/onesub/entitlements',
  METRICS_ACTIVE: '/onesub/metrics/active',
  METRICS_STARTED: '/onesub/metrics/started',
  METRICS_EXPIRED: '/onesub/metrics/expired',
  /** Non-consumable purchases started in the window (purchasedAt-based). */
  METRICS_PURCHASES_STARTED: '/onesub/metrics/purchases/started',
  ADMIN_SUBSCRIPTIONS: '/onesub/admin/subscriptions',
  /** Single-record detail; takes :transactionId path param. */
  ADMIN_SUBSCRIPTION_DETAIL: '/onesub/admin/subscriptions/:transactionId',
  /** Per-user profile bundle (subs + purchases + entitlements); takes :userId path param. */
  ADMIN_CUSTOMER_DETAIL: '/onesub/admin/customers/:userId',
} as const;

/** Default server port */
export const DEFAULT_PORT = 4100;

/** Subscription status values */
export const SUBSCRIPTION_STATUS = {
  ACTIVE: 'active',
  /** Payment failed but the store still grants access while retrying. Treat as entitled. */
  GRACE_PERIOD: 'grace_period',
  /** Payment failed; retry/grace window expired; entitlement REVOKED until user fixes payment. */
  ON_HOLD: 'on_hold',
  /** User-voluntary pause (Google only); entitlement REVOKED until autoResumeTime or manual resume. */
  PAUSED: 'paused',
  EXPIRED: 'expired',
  CANCELED: 'canceled',
  NONE: 'none',
} as const;

/** Purchase type values */
export const PURCHASE_TYPE = {
  CONSUMABLE: 'consumable',
  NON_CONSUMABLE: 'non_consumable',
  SUBSCRIPTION: 'subscription',
} as const;

/**
 * Canonical error codes returned by the server and thrown by the SDK.
 * Clients should branch on these machine-readable codes rather than parsing
 * human-readable `error` strings. The `OneSubError` class in `@jeonghwanko/onesub-sdk`
 * carries one of these in its `.code` property.
 */
export const ONESUB_ERROR_CODE = {
  // ── Input / configuration (client sent bad request, or server misconfigured) ──
  INVALID_INPUT: 'INVALID_INPUT',
  APPLE_CONFIG_MISSING: 'APPLE_CONFIG_MISSING',
  GOOGLE_CONFIG_MISSING: 'GOOGLE_CONFIG_MISSING',
  USER_ID_TOO_LONG: 'USER_ID_TOO_LONG',

  // ── Receipt validation ──
  RECEIPT_VALIDATION_FAILED: 'RECEIPT_VALIDATION_FAILED',
  NO_RECEIPT_DATA: 'NO_RECEIPT_DATA',

  // ── Authorization ──
  UNAUTHORIZED: 'UNAUTHORIZED',
  INVALID_ADMIN_SECRET: 'INVALID_ADMIN_SECRET',

  // ── Ownership / conflict ──
  TRANSACTION_BELONGS_TO_OTHER_USER: 'TRANSACTION_BELONGS_TO_OTHER_USER',
  TRANSACTION_NOT_FOUND: 'TRANSACTION_NOT_FOUND',
  NON_CONSUMABLE_ALREADY_OWNED: 'NON_CONSUMABLE_ALREADY_OWNED',

  // ── Webhook specific ──
  MISSING_SIGNED_PAYLOAD: 'MISSING_SIGNED_PAYLOAD',
  INVALID_SIGNED_PAYLOAD: 'INVALID_SIGNED_PAYLOAD',
  MISSING_MESSAGE_DATA: 'MISSING_MESSAGE_DATA',
  PACKAGE_NAME_MISMATCH: 'PACKAGE_NAME_MISMATCH',

  // ── Entitlements ──
  ENTITLEMENT_NOT_FOUND: 'ENTITLEMENT_NOT_FOUND',
  ENTITLEMENTS_NOT_CONFIGURED: 'ENTITLEMENTS_NOT_CONFIGURED',

  // ── Server internal ──
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  STORE_ERROR: 'STORE_ERROR',
  WEBHOOK_PROCESSING_FAILED: 'WEBHOOK_PROCESSING_FAILED',

  // ── SDK client ──
  NOT_IN_PROVIDER: 'NOT_IN_PROVIDER',
  RN_IAP_NOT_INSTALLED: 'RN_IAP_NOT_INSTALLED',
  PRODUCT_NOT_FOUND: 'PRODUCT_NOT_FOUND',
  PURCHASE_TIMEOUT: 'PURCHASE_TIMEOUT',
  USER_CANCELLED: 'USER_CANCELLED',
  CONCURRENT_PURCHASE: 'CONCURRENT_PURCHASE',
  PROVIDER_UNMOUNTED: 'PROVIDER_UNMOUNTED',
  NETWORK_ERROR: 'NETWORK_ERROR',
} as const;

/** Union of all canonical error code string literals. */
export type OneSubErrorCode = typeof ONESUB_ERROR_CODE[keyof typeof ONESUB_ERROR_CODE];

/**
 * Receipt string prefixes that the mock providers (when `config.{apple,google}.mockMode`
 * is true) interpret as specific test scenarios. Send one of these as the
 * `receipt` field to exercise the corresponding code path without real store
 * credentials. Anything not matching these prefixes is treated as a valid
 * receipt (deterministic fake transactionId derived from the string).
 */
export const MOCK_RECEIPT_PREFIX = {
  REVOKED: 'MOCK_REVOKED',
  EXPIRED: 'MOCK_EXPIRED',
  INVALID: 'MOCK_INVALID',
  BAD_SIG: 'MOCK_BAD_SIG',
  NETWORK_ERROR: 'MOCK_NETWORK_ERROR',
  SANDBOX: 'MOCK_SANDBOX',
} as const;
