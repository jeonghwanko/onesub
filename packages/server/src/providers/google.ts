import type { SubscriptionInfo, GoogleNotificationPayload, OneSubServerConfig } from '@onesub/shared';
import { SUBSCRIPTION_STATUS } from '@onesub/shared';
import { log } from '../logger.js';
import { fetchWithTimeout } from '../http.js';
import { getDefaultCache } from '../cache.js';
import {
  mockValidateGoogleSubscription,
  mockValidateGoogleProduct,
} from './mock.js';

type GoogleConfig = NonNullable<OneSubServerConfig['google']>;

/**
 * Google Play Developer API v3 — SubscriptionPurchaseV2 resource (partial).
 * https://developers.google.com/android-publisher/api-ref/rest/v3/purchases.subscriptionsv2/get
 *
 * V2 differences from the deprecated V1 (purchases.subscriptions):
 *   - URL doesn't take productId — one token can map to multiple lineItems
 *   - subscriptionState is a string enum (explicit grace/hold/paused) instead
 *     of being inferred from expiryTime
 *   - lineItems[] carries per-product productId + expiryTime + autoRenewingPlan
 *   - linkedPurchaseToken first-class (upgrade/downgrade chain tracking)
 *   - latestOrderId replaces orderId as the canonical transaction id
 */
interface GoogleSubscriptionPurchaseV2 {
  kind?: string;                   // 'androidpublisher#subscriptionPurchaseV2'
  startTime?: string;              // RFC3339 (ISO 8601)
  regionCode?: string;
  lineItems?: Array<{
    productId?: string;
    expiryTime?: string;           // RFC3339
    autoRenewingPlan?: {
      autoRenewEnabled?: boolean;
      priceChangeDetails?: unknown;
    };
    prepaidPlan?: {
      allowExtendAfterTime?: string;
    };
    offerDetails?: unknown;
  }>;
  subscriptionState?:
    | 'SUBSCRIPTION_STATE_UNSPECIFIED'
    | 'SUBSCRIPTION_STATE_PENDING'
    | 'SUBSCRIPTION_STATE_ACTIVE'
    | 'SUBSCRIPTION_STATE_PAUSED'
    | 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD'
    | 'SUBSCRIPTION_STATE_ON_HOLD'
    | 'SUBSCRIPTION_STATE_CANCELED'
    | 'SUBSCRIPTION_STATE_EXPIRED';
  latestOrderId?: string;
  linkedPurchaseToken?: string;
  acknowledgementState?:
    | 'ACKNOWLEDGEMENT_STATE_UNSPECIFIED'
    | 'ACKNOWLEDGEMENT_STATE_PENDING'
    | 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED';
  pausedStateContext?: { autoResumeTime?: string };
  canceledStateContext?: unknown;
  testPurchase?: unknown;
  [key: string]: unknown;
}

/**
 * Google RTDN notification types.
 * https://developer.android.com/google/play/billing/rtdn-reference
 */
const GOOGLE_NOTIFICATION_TYPE = {
  SUBSCRIPTION_RECOVERED: 1,
  SUBSCRIPTION_RENEWED: 2,
  SUBSCRIPTION_CANCELED: 3,
  SUBSCRIPTION_PURCHASED: 4,
  SUBSCRIPTION_ON_HOLD: 5,
  SUBSCRIPTION_IN_GRACE_PERIOD: 6,
  SUBSCRIPTION_RESTARTED: 7,
  SUBSCRIPTION_PRICE_CHANGE_CONFIRMED: 8,
  SUBSCRIPTION_DEFERRED: 9,
  SUBSCRIPTION_PAUSED: 10,
  SUBSCRIPTION_PAUSE_SCHEDULE_CHANGED: 11,
  SUBSCRIPTION_REVOKED: 12,
  SUBSCRIPTION_EXPIRED: 13,
} as const;

type GoogleNotificationType = (typeof GOOGLE_NOTIFICATION_TYPE)[keyof typeof GOOGLE_NOTIFICATION_TYPE];

/**
 * Parsed Google RTDN inner message.
 */
interface GoogleDeveloperNotification {
  version?: string;
  packageName: string;
  eventTimeMillis: string;
  subscriptionNotification?: {
    version: string;
    notificationType: GoogleNotificationType;
    purchaseToken: string;
    subscriptionId: string;
  };
  voidedPurchaseNotification?: {
    purchaseToken: string;
    orderId: string;
    /** 1 = Subscription, 2 = One-time product */
    productType: 1 | 2;
    /** 1 = Full refund, 2 = Quantity-based partial refund (consumables) */
    refundType: 1 | 2;
  };
  oneTimeProductNotification?: {
    version: string;
    /** 1 = PURCHASED, 2 = CANCELED */
    notificationType: 1 | 2;
    purchaseToken: string;
    /** Product SKU (productId) */
    sku: string;
  };
  testNotification?: {
    version: string;
  };
}

/**
 * Decoded Google RTDN oneTimeProductNotification — sent when a consumable or
 * non-consumable product is purchased or canceled before acknowledgment.
 *
 * https://developer.android.com/google/play/billing/rtdn-reference#one-time
 */
export interface GoogleOneTimeProductNotification {
  /** 1 = PURCHASED, 2 = CANCELED (user canceled before purchase completed) */
  notificationType: 1 | 2;
  purchaseToken: string;
  /** Product SKU / productId */
  sku: string;
  packageName: string;
}

/**
 * Google Play Developer API v3 — ProductPurchase resource (consumable / non-consumable).
 * https://developers.google.com/android-publisher/api-ref/rest/v3/purchases.products
 */
interface GoogleProductPurchase {
  purchaseTimeMillis?: string;
  purchaseState?: number;       // 0 = Purchased, 1 = Canceled, 2 = Pending
  consumptionState?: number;    // 0 = Not consumed, 1 = Consumed
  orderId?: string;
  [key: string]: unknown;
}

/** Maximum age for product receipts (72 hours). */
const MAX_PRODUCT_RECEIPT_AGE_MS = 72 * 60 * 60 * 1000;

/**
 * Per-key in-flight token mint promises. Used to deduplicate concurrent
 * refreshes inside a single process — the cluster-wide cache layer sits in
 * `getDefaultCache()` underneath. Without this map every concurrent caller in
 * the same process would fire a separate network refresh while waiting for
 * the new value to land in Redis / memory.
 */
const refreshPromises = new Map<string, Promise<string>>();

/**
 * Build the cache key for a given service account.
 *
 * Hashing the key (instead of using it raw) keeps the key length bounded for
 * cache backends that have key-size limits, and avoids leaking partial JSON
 * into log lines that print cache keys.
 */
function googleTokenCacheKey(serviceAccountKey: string): string {
  let hash = 0;
  for (let i = 0; i < serviceAccountKey.length; i++) {
    hash = (hash * 31 + serviceAccountKey.charCodeAt(i)) | 0;
  }
  return `google:oauth:${hash}`;
}

/**
 * Obtain a Google OAuth2 access token, returning a cached token if it has more
 * than 60 seconds of remaining validity. Google tokens are valid for 3600 seconds,
 * so this avoids a network round-trip on every API call.
 *
 * Cache layer: `getDefaultCache()` (in-memory by default, swappable with
 * Redis / Memcached via `setDefaultCache()`). When the cache is shared across
 * cluster nodes only one node refreshes per TTL window.
 *
 * Promise deduplication prevents a thundering herd inside a single process:
 * concurrent callers that arrive while the token is being refreshed all await
 * the same in-flight request instead of each issuing their own.
 */
async function getCachedAccessToken(serviceAccountKey: string): Promise<string> {
  const cache = getDefaultCache();
  const cacheKey = googleTokenCacheKey(serviceAccountKey);

  const cached = await cache.get<{ token: string; expiresAt: number }>(cacheKey);
  if (cached && cached.expiresAt - Date.now() > 60_000) {
    return cached.token;
  }

  const inflight = refreshPromises.get(cacheKey);
  if (inflight) return inflight;

  const promise = getAccessToken(serviceAccountKey)
    .then(async (token) => {
      const expiresAt = Date.now() + 3_600_000;
      // TTL slightly under the 1h Google validity — cache eviction matches token expiry.
      await cache.set(cacheKey, { token, expiresAt }, 3_540);
      return token;
    })
    .finally(() => {
      refreshPromises.delete(cacheKey);
    });
  refreshPromises.set(cacheKey, promise);
  return promise;
}

/**
 * Obtain a Google OAuth2 access token using a service account key (JWT assertion flow).
 * The serviceAccountKey is expected to be a JSON string of the service account credentials.
 */
async function getAccessToken(serviceAccountKey: string): Promise<string> {
  let key: {
    client_email: string;
    private_key: string;
    token_uri?: string;
  };

  try {
    key = JSON.parse(serviceAccountKey) as typeof key;
  } catch {
    throw new Error('[onesub/google] Invalid serviceAccountKey JSON');
  }

  const tokenUri = key.token_uri ?? 'https://oauth2.googleapis.com/token';
  const scope = 'https://www.googleapis.com/auth/androidpublisher';
  const now = Math.floor(Date.now() / 1000);

  // Build a JWT assertion
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      iss: key.client_email,
      scope,
      aud: tokenUri,
      iat: now,
      exp: now + 3600,
    })
  ).toString('base64url');

  const signingInput = `${header}.${payload}`;

  // Sign with the private key using the native crypto module
  const { createSign } = await import('crypto');
  const sign = createSign('RSA-SHA256');
  sign.update(signingInput);
  const signature = sign.sign(key.private_key, 'base64url');

  const assertion = `${signingInput}.${signature}`;

  const resp = await fetchWithTimeout(tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });

  if (!resp.ok) {
    throw new Error(`[onesub/google] Token request failed: ${resp.status}`);
  }

  const data = (await resp.json()) as { access_token?: string };
  if (!data.access_token) throw new Error('[onesub/google] No access_token in response');
  return data.access_token;
}

/**
 * Fetch a subscription purchase from the Google Play Developer API
 * (purchases.subscriptionsv2.get). The v2 endpoint takes only the purchaseToken
 * — the productId comes back in lineItems, which lets one token represent a
 * multi-product subscription.
 */
async function fetchSubscriptionPurchaseV2(
  packageName: string,
  purchaseToken: string,
  accessToken: string,
): Promise<GoogleSubscriptionPurchaseV2> {
  const url =
    `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/` +
    `${encodeURIComponent(packageName)}/purchases/subscriptionsv2/tokens/` +
    `${encodeURIComponent(purchaseToken)}`;

  const resp = await fetchWithTimeout(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`[onesub/google] Play API v2 error ${resp.status}: ${body}`);
  }

  return resp.json() as Promise<GoogleSubscriptionPurchaseV2>;
}

/**
 * Fetch a one-time product purchase from the Google Play Developer API.
 * Uses purchases.products instead of purchases.subscriptions.
 */
async function fetchProductPurchase(
  packageName: string,
  productId: string,
  purchaseToken: string,
  accessToken: string,
): Promise<GoogleProductPurchase> {
  const url =
    `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/` +
    `${encodeURIComponent(packageName)}/purchases/products/` +
    `${encodeURIComponent(productId)}/tokens/${encodeURIComponent(purchaseToken)}`;

  const resp = await fetchWithTimeout(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`[onesub/google] Play Products API error ${resp.status}: ${body}`);
  }

  return resp.json() as Promise<GoogleProductPurchase>;
}

/**
 * Acknowledge a Google Play subscription purchase.
 * Google auto-refunds purchases that are not acknowledged within 3 days.
 *
 * Idempotent on Google's side: a no-op when the purchase has already been
 * acknowledged. Fire-and-forget — entitlement was already granted, so failures
 * are logged but not surfaced to the caller (operations should monitor logs).
 */
export async function acknowledgeGoogleSubscription(
  purchaseToken: string,
  productId: string,
  config: GoogleConfig,
): Promise<void> {
  if (config.mockMode) return;
  if (!config.serviceAccountKey) return;
  if (!config.packageName) return;

  let accessToken: string;
  try {
    accessToken = await getCachedAccessToken(config.serviceAccountKey);
  } catch (err) {
    log.warn('[onesub/google] Could not get access token for subscription ack:', err);
    return;
  }

  const url =
    `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/` +
    `${encodeURIComponent(config.packageName)}/purchases/subscriptions/` +
    `${encodeURIComponent(productId)}/tokens/${encodeURIComponent(purchaseToken)}:acknowledge`;

  try {
    const resp = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: '{}',
    });

    if (!resp.ok) {
      const body = await resp.text();
      log.warn(`[onesub/google] Subscription acknowledge API error ${resp.status}: ${body} — auto-refund risk`);
    }
  } catch (err) {
    log.warn('[onesub/google] Subscription acknowledge network error — auto-refund risk:', err);
  }
}

/**
 * Acknowledge a Google Play one-time product purchase (non-consumable).
 * Consumables do not need this — :consume implicitly acknowledges.
 *
 * Same fire-and-forget semantics as acknowledgeGoogleSubscription.
 */
export async function acknowledgeGoogleProduct(
  purchaseToken: string,
  productId: string,
  config: GoogleConfig,
): Promise<void> {
  if (config.mockMode) return;
  if (!config.serviceAccountKey) return;
  if (!config.packageName) return;

  let accessToken: string;
  try {
    accessToken = await getCachedAccessToken(config.serviceAccountKey);
  } catch (err) {
    log.warn('[onesub/google] Could not get access token for product ack:', err);
    return;
  }

  const url =
    `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/` +
    `${encodeURIComponent(config.packageName)}/purchases/products/` +
    `${encodeURIComponent(productId)}/tokens/${encodeURIComponent(purchaseToken)}:acknowledge`;

  try {
    const resp = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: '{}',
    });

    if (!resp.ok) {
      const body = await resp.text();
      log.warn(`[onesub/google] Product acknowledge API error ${resp.status}: ${body} — auto-refund risk`);
    }
  } catch (err) {
    log.warn('[onesub/google] Product acknowledge network error — auto-refund risk:', err);
  }
}

/**
 * Consume a one-time product purchase via the Google Play Developer API.
 * Must be called for consumables after the entitlement is granted to the user.
 * Google auto-refunds unconsumed purchases after 3 days.
 *
 * This function does not throw — callers should log failures and monitor,
 * as the entitlement has already been granted.
 */
export async function consumeGoogleProductReceipt(
  purchaseToken: string,
  productId: string,
  config: GoogleConfig,
): Promise<void> {
  if (!config.serviceAccountKey) return;
  if (!config.packageName) return;

  let accessToken: string;
  try {
    accessToken = await getCachedAccessToken(config.serviceAccountKey);
  } catch (err) {
    log.warn('[onesub/google] Could not get access token for consume:', err);
    return;
  }

  const url =
    `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/` +
    `${encodeURIComponent(config.packageName)}/purchases/products/` +
    `${encodeURIComponent(productId)}/tokens/${encodeURIComponent(purchaseToken)}:consume`;

  try {
    const resp = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!resp.ok) {
      const body = await resp.text();
      log.warn(`[onesub/google] Consume API error ${resp.status}: ${body} — auto-refund risk`);
    }
  } catch (err) {
    log.warn('[onesub/google] Consume network error — auto-refund risk:', err);
  }
}

/**
 * Map a v2 subscriptionState string to onesub SubscriptionStatus.
 *
 * Returns null when the state is unrecognised or PENDING (initial purchase
 * not yet settled — entitlement should not be granted yet).
 */
function deriveStatusV2(
  state: GoogleSubscriptionPurchaseV2['subscriptionState'],
): SubscriptionInfo['status'] | null {
  switch (state) {
    case 'SUBSCRIPTION_STATE_ACTIVE':
      return SUBSCRIPTION_STATUS.ACTIVE;
    case 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD':
      return SUBSCRIPTION_STATUS.GRACE_PERIOD;
    case 'SUBSCRIPTION_STATE_ON_HOLD':
      return SUBSCRIPTION_STATUS.ON_HOLD;
    case 'SUBSCRIPTION_STATE_PAUSED':
      return SUBSCRIPTION_STATUS.PAUSED;
    case 'SUBSCRIPTION_STATE_CANCELED':
      return SUBSCRIPTION_STATUS.CANCELED;
    case 'SUBSCRIPTION_STATE_EXPIRED':
      return SUBSCRIPTION_STATUS.EXPIRED;
    case 'SUBSCRIPTION_STATE_PENDING':
    case 'SUBSCRIPTION_STATE_UNSPECIFIED':
    default:
      return null;
  }
}

/**
 * Validate a Google Play purchase token via purchases.subscriptionsv2.get.
 *
 * The productId argument is used to pick the matching `lineItems` entry. If
 * the response has no lineItem with that productId, validation fails — the
 * token does not entitle the caller to that product. (For multi-product
 * subscriptions, callers can read other lineItems out of the API directly.)
 *
 * @param receipt    The purchaseToken from the client (Google Play Billing)
 * @param productId  Expected subscription productId — must match a lineItem
 * @param config     Google config with packageName + optional serviceAccountKey
 */
export async function validateGoogleReceipt(
  receipt: string,
  productId: string,
  config: GoogleConfig
): Promise<SubscriptionInfo | null> {
  if (config.mockMode) return mockValidateGoogleSubscription(receipt, productId);
  if (!config.serviceAccountKey) {
    log.warn('[onesub/google] No serviceAccountKey provided — cannot call Play API');
    return null;
  }
  if (!config.packageName) {
    log.warn('[onesub/google] No packageName provided — cannot call Play API');
    return null;
  }

  let purchase: GoogleSubscriptionPurchaseV2;
  try {
    const token = await getCachedAccessToken(config.serviceAccountKey);
    purchase = await fetchSubscriptionPurchaseV2(config.packageName, receipt, token);
  } catch (err) {
    log.error('[onesub/google] Receipt validation failed:', err);
    return null;
  }

  const status = deriveStatusV2(purchase.subscriptionState);
  if (!status) {
    log.warn(
      '[onesub/google] Unrecognised or pending subscriptionState — rejecting:',
      purchase.subscriptionState,
    );
    return null;
  }

  // Pick the lineItem matching the requested productId. v2 supports multi-product
  // subscriptions so the same token can carry several lineItems; we only entitle
  // the caller for the productId they explicitly asked about.
  const lineItem = purchase.lineItems?.find((item) => item.productId === productId);
  if (!lineItem) {
    log.warn(
      '[onesub/google] productId not found in subscription lineItems:',
      productId,
      'available:',
      purchase.lineItems?.map((i) => i.productId).join(', ') ?? '(none)',
    );
    return null;
  }

  const expiresAt = lineItem.expiryTime ?? new Date().toISOString();
  const purchasedAt = purchase.startTime ?? new Date().toISOString();
  const willRenew = lineItem.autoRenewingPlan?.autoRenewEnabled ?? false;

  // Surface autoResumeTime only when the subscription is actually paused —
  // pausedStateContext is undefined for any other state, but be defensive in
  // case Google starts including it on adjacent states (e.g. recently-resumed).
  const autoResumeTime =
    status === SUBSCRIPTION_STATUS.PAUSED
      ? purchase.pausedStateContext?.autoResumeTime
      : undefined;

  return {
    userId: '',  // caller fills this in
    productId,
    platform: 'google',
    status,
    expiresAt,
    originalTransactionId: purchase.latestOrderId ?? receipt.slice(0, 64),
    purchasedAt,
    willRenew,
    // Surface the linked token so host apps (and our webhook userId-continuity
    // logic) can follow upgrade/downgrade chains.
    linkedPurchaseToken: purchase.linkedPurchaseToken,
    autoResumeTime,
  };
}

/**
 * Result of validating a Google Play product (consumable / non-consumable) receipt.
 */
export interface GoogleProductResult {
  /** orderId — unique per Google Play transaction, safe deduplication key */
  transactionId: string;
  purchasedAt: string;
}

/**
 * Validate a Google Play purchase token for a one-time product (consumable or
 * non-consumable). Uses purchases.products, not purchases.subscriptions.
 *
 * Security checks applied beyond basic API verification:
 * - purchaseState must be 0 (completed)
 * - consumptionState checked for consumables: already-consumed tokens indicate replay
 * - Receipt age limited to 72 hours
 * - orderId used as transactionId (per-purchase unique, unlike purchaseToken)
 */
export async function validateGoogleProductReceipt(
  purchaseToken: string,
  productId: string,
  config: GoogleConfig,
  type: 'consumable' | 'non_consumable' = 'non_consumable',
): Promise<GoogleProductResult | null> {
  if (config.mockMode) return mockValidateGoogleProduct(purchaseToken, productId);
  if (!config.serviceAccountKey) {
    log.warn('[onesub/google] No serviceAccountKey — cannot validate product receipt');
    return null;
  }
  if (!config.packageName) {
    log.warn('[onesub/google] No packageName — cannot validate product receipt');
    return null;
  }

  let purchase: GoogleProductPurchase;
  try {
    const token = await getCachedAccessToken(config.serviceAccountKey);
    purchase = await fetchProductPurchase(config.packageName, productId, purchaseToken, token);
  } catch (err) {
    log.error('[onesub/google] Product receipt validation failed:', err);
    return null;
  }

  // purchaseState 0 = completed (1 = canceled, 2 = pending)
  if (purchase.purchaseState !== 0) {
    log.warn('[onesub/google] Purchase not completed, state:', purchase.purchaseState);
    return null;
  }

  // For consumables: consumptionState 1 means already consumed by a previous request.
  // This is the primary replay-attack signal for consumables on Android.
  if (type === 'consumable' && purchase.consumptionState === 1) {
    log.warn('[onesub/google] Consumable already consumed — possible replay attack');
    return null;
  }

  // Reject receipts older than 72 hours
  if (purchase.purchaseTimeMillis) {
    const purchaseTime = parseInt(purchase.purchaseTimeMillis, 10);
    if (Date.now() - purchaseTime > MAX_PRODUCT_RECEIPT_AGE_MS) {
      log.warn('[onesub/google] Product receipt too old (>72h)');
      return null;
    }
  }

  if (!purchase.orderId) {
    log.warn('[onesub/google] No orderId in product purchase');
    return null;
  }

  return {
    transactionId: purchase.orderId,
    purchasedAt: purchase.purchaseTimeMillis
      ? new Date(parseInt(purchase.purchaseTimeMillis, 10)).toISOString()
      : new Date().toISOString(),
  };
}

/**
 * Decode a Google RTDN Pub/Sub notification.
 * Returns the extracted subscription notification data, or null for test pings
 * and notification kinds handled by other decoders (e.g. voided purchases).
 */
export function decodeGoogleNotification(payload: GoogleNotificationPayload): {
  notificationType: GoogleNotificationType;
  purchaseToken: string;
  subscriptionId: string;
  packageName: string;
} | null {
  let notification: GoogleDeveloperNotification;

  try {
    const json = Buffer.from(payload.message.data, 'base64').toString('utf-8');
    notification = JSON.parse(json) as GoogleDeveloperNotification;
  } catch {
    return null;
  }

  if (!notification.subscriptionNotification) {
    // test notification, voided purchase, or unsupported type
    return null;
  }

  const { notificationType, purchaseToken, subscriptionId } = notification.subscriptionNotification;

  return {
    notificationType,
    purchaseToken,
    subscriptionId,
    packageName: notification.packageName,
  };
}

/**
 * Decoded Google RTDN voidedPurchaseNotification — sent when a purchase
 * (subscription or one-time product) is refunded, charged back, or revoked.
 *
 * https://developer.android.com/google/play/billing/rtdn-reference#voided-purchase
 */
export interface GoogleVoidedNotification {
  /** Subscription purchaseToken or one-time product purchaseToken */
  purchaseToken: string;
  /** GPA.* — matches the orderId stored as transactionId for one-time products */
  orderId: string;
  /** 1 = Subscription, 2 = One-time product */
  productType: 1 | 2;
  /** 1 = Full refund, 2 = Quantity-based partial refund (consumables) */
  refundType: 1 | 2;
  packageName: string;
}

/**
 * Decode a Google RTDN voidedPurchaseNotification, if the payload is one.
 * Returns null when the payload is a different notification kind.
 */
export function decodeGoogleVoidedNotification(
  payload: GoogleNotificationPayload,
): GoogleVoidedNotification | null {
  let notification: GoogleDeveloperNotification;

  try {
    const json = Buffer.from(payload.message.data, 'base64').toString('utf-8');
    notification = JSON.parse(json) as GoogleDeveloperNotification;
  } catch {
    return null;
  }

  if (!notification.voidedPurchaseNotification) return null;

  const { purchaseToken, orderId, productType, refundType } = notification.voidedPurchaseNotification;

  return {
    purchaseToken,
    orderId,
    productType,
    refundType,
    packageName: notification.packageName,
  };
}

/**
 * Decode a Google RTDN oneTimeProductNotification, if the payload is one.
 * Returns null when the payload is a different notification kind.
 *
 * Note: the notification does NOT carry userId context. For PURCHASED, the
 * receipt must be acknowledged via acknowledgeGoogleProduct to prevent the
 * 3-day auto-refund window. The userId is only known after the client calls
 * POST /onesub/purchase/validate, which is the authoritative record-creation
 * path. The webhook handler therefore acknowledges without creating a record.
 */
export function decodeGoogleOneTimeProductNotification(
  payload: GoogleNotificationPayload,
): GoogleOneTimeProductNotification | null {
  let notification: GoogleDeveloperNotification;
  try {
    const json = Buffer.from(payload.message.data, 'base64').toString('utf-8');
    notification = JSON.parse(json) as GoogleDeveloperNotification;
  } catch {
    return null;
  }
  if (!notification.oneTimeProductNotification) return null;
  const { notificationType, purchaseToken, sku } = notification.oneTimeProductNotification;
  return { notificationType, purchaseToken, sku, packageName: notification.packageName };
}

/**
 * Determine if a Google RTDN notification type represents an active subscription
 * inside the paid window (excludes grace period — that's a separate state now).
 */
export function isGoogleActiveNotification(notificationType: GoogleNotificationType): boolean {
  return (
    notificationType === GOOGLE_NOTIFICATION_TYPE.SUBSCRIPTION_PURCHASED ||
    notificationType === GOOGLE_NOTIFICATION_TYPE.SUBSCRIPTION_RENEWED ||
    notificationType === GOOGLE_NOTIFICATION_TYPE.SUBSCRIPTION_RECOVERED ||
    notificationType === GOOGLE_NOTIFICATION_TYPE.SUBSCRIPTION_RESTARTED
  );
}

export function isGoogleCanceledNotification(notificationType: GoogleNotificationType): boolean {
  return (
    notificationType === GOOGLE_NOTIFICATION_TYPE.SUBSCRIPTION_CANCELED ||
    notificationType === GOOGLE_NOTIFICATION_TYPE.SUBSCRIPTION_REVOKED
  );
}

export function isGoogleExpiredNotification(notificationType: GoogleNotificationType): boolean {
  return notificationType === GOOGLE_NOTIFICATION_TYPE.SUBSCRIPTION_EXPIRED;
}

/**
 * Subscription is in the store-granted grace period — payment failed but the
 * user retains access while Google retries. Maps to SUBSCRIPTION_STATUS.GRACE_PERIOD.
 */
export function isGoogleGracePeriodNotification(notificationType: GoogleNotificationType): boolean {
  return notificationType === GOOGLE_NOTIFICATION_TYPE.SUBSCRIPTION_IN_GRACE_PERIOD;
}

/**
 * Subscription is on hold — grace period ended, retry continuing, entitlement
 * REVOKED. Maps to SUBSCRIPTION_STATUS.ON_HOLD.
 */
export function isGoogleOnHoldNotification(notificationType: GoogleNotificationType): boolean {
  return notificationType === GOOGLE_NOTIFICATION_TYPE.SUBSCRIPTION_ON_HOLD;
}

/**
 * User-voluntary pause — entitlement REVOKED until autoResumeTime or manual
 * resume. Maps to SUBSCRIPTION_STATUS.PAUSED.
 */
export function isGooglePausedNotification(notificationType: GoogleNotificationType): boolean {
  return notificationType === GOOGLE_NOTIFICATION_TYPE.SUBSCRIPTION_PAUSED;
}

/**
 * User agreed to a developer-initiated price change. The new price applies
 * on the next renewal. Subscription remains active in the meantime.
 */
export function isGooglePriceChangeConfirmedNotification(notificationType: GoogleNotificationType): boolean {
  return notificationType === GOOGLE_NOTIFICATION_TYPE.SUBSCRIPTION_PRICE_CHANGE_CONFIRMED;
}
