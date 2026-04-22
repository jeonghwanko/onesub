import type { SubscriptionInfo, GoogleNotificationPayload, OneSubServerConfig } from '@onesub/shared';
import { SUBSCRIPTION_STATUS } from '@onesub/shared';
import { log } from '../logger.js';
import {
  mockValidateGoogleSubscription,
  mockValidateGoogleProduct,
} from './mock.js';

type GoogleConfig = NonNullable<OneSubServerConfig['google']>;

/**
 * Google Play Developer API v3 — SubscriptionPurchase resource (partial).
 * https://developers.google.com/android-publisher/api-ref/rest/v3/purchases.subscriptions
 */
interface GoogleSubscriptionPurchase {
  kind?: string;                   // 'androidpublisher#subscriptionPurchase'
  startTimeMillis?: string;
  expiryTimeMillis?: string;
  autoRenewing?: boolean;
  priceCurrencyCode?: string;
  priceAmountMicros?: string;
  cancelReason?: number;           // 0=User, 1=System, 2=Replaced, 3=Developer
  paymentState?: number;           // 0=Pending, 1=Received, 2=Free trial, 3=Deferred
  cancelSurveyResult?: unknown;
  purchaseType?: number;           // 0=Test, 1=Promo
  acknowledgementState?: number;   // 0=Yet to be acknowledged, 1=Acknowledged
  orderId?: string;
  linkedPurchaseToken?: string;
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
  testNotification?: {
    version: string;
  };
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
 * Module-level token cache. Keyed by the raw serviceAccountKey string so that
 * different service accounts (rare but possible) are cached independently.
 */
let cachedToken: { token: string; expiresAt: number; key: string } | null = null;
let refreshPromise: Promise<string> | null = null;

/**
 * Obtain a Google OAuth2 access token, returning a cached token if it has more
 * than 60 seconds of remaining validity. Google tokens are valid for 3600 seconds,
 * so this avoids a network round-trip on every API call.
 *
 * Promise deduplication prevents a thundering herd: concurrent callers that
 * arrive while the token is being refreshed all await the same in-flight
 * request instead of each issuing their own.
 */
async function getCachedAccessToken(serviceAccountKey: string): Promise<string> {
  const now = Date.now();
  if (cachedToken && cachedToken.key === serviceAccountKey && cachedToken.expiresAt - now > 60_000) {
    return cachedToken.token;
  }
  if (!refreshPromise) {
    refreshPromise = getAccessToken(serviceAccountKey)
      .then((token) => {
        cachedToken = { token, expiresAt: Date.now() + 3_600_000, key: serviceAccountKey };
        return token;
      })
      .finally(() => { refreshPromise = null; });
  }
  return refreshPromise;
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

  const resp = await fetch(tokenUri, {
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
 * Fetch a subscription purchase from the Google Play Developer API.
 */
async function fetchSubscriptionPurchase(
  packageName: string,
  productId: string,
  purchaseToken: string,
  accessToken: string
): Promise<GoogleSubscriptionPurchase> {
  const url = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(packageName)}/purchases/subscriptions/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(purchaseToken)}`;

  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`[onesub/google] Play API error ${resp.status}: ${body}`);
  }

  return resp.json() as Promise<GoogleSubscriptionPurchase>;
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

  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`[onesub/google] Play Products API error ${resp.status}: ${body}`);
  }

  return resp.json() as Promise<GoogleProductPurchase>;
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
    const resp = await fetch(url, {
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
 * Derive a SubscriptionStatus from a Google Play purchase resource.
 */
function deriveStatus(purchase: GoogleSubscriptionPurchase): SubscriptionInfo['status'] {
  const now = Date.now();
  const expiryMs = purchase.expiryTimeMillis ? parseInt(purchase.expiryTimeMillis, 10) : 0;

  if (expiryMs > now) {
    // paymentState 0 = pending (grace period treated as active)
    return SUBSCRIPTION_STATUS.ACTIVE;
  }

  if (purchase.cancelReason !== undefined) return SUBSCRIPTION_STATUS.CANCELED;

  return SUBSCRIPTION_STATUS.EXPIRED;
}

/**
 * Validate a Google Play purchase token.
 *
 * @param receipt  - The purchaseToken from the client (Google Play Billing)
 * @param productId - The subscription product ID
 * @param config   - Google config with packageName and optional serviceAccountKey
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

  let purchase: GoogleSubscriptionPurchase;
  try {
    const token = await getCachedAccessToken(config.serviceAccountKey);
    purchase = await fetchSubscriptionPurchase(config.packageName, productId, receipt, token);
  } catch (err) {
    log.error('[onesub/google] Receipt validation failed:', err);
    return null;
  }

  const status = deriveStatus(purchase);
  const expiryMs = purchase.expiryTimeMillis ? parseInt(purchase.expiryTimeMillis, 10) : Date.now();
  const startMs = purchase.startTimeMillis ? parseInt(purchase.startTimeMillis, 10) : Date.now();

  return {
    userId: '',  // caller fills this in
    productId,
    platform: 'google',
    status,
    expiresAt: new Date(expiryMs).toISOString(),
    originalTransactionId: purchase.orderId ?? receipt.slice(0, 64),
    purchasedAt: new Date(startMs).toISOString(),
    willRenew: purchase.autoRenewing ?? false,
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
 * Returns the extracted subscription notification data, or null for test pings.
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
    // test notification or unsupported type
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
 * Determine if a Google RTDN notification type represents an active subscription.
 */
export function isGoogleActiveNotification(notificationType: GoogleNotificationType): boolean {
  return (
    notificationType === GOOGLE_NOTIFICATION_TYPE.SUBSCRIPTION_PURCHASED ||
    notificationType === GOOGLE_NOTIFICATION_TYPE.SUBSCRIPTION_RENEWED ||
    notificationType === GOOGLE_NOTIFICATION_TYPE.SUBSCRIPTION_RECOVERED ||
    notificationType === GOOGLE_NOTIFICATION_TYPE.SUBSCRIPTION_RESTARTED ||
    notificationType === GOOGLE_NOTIFICATION_TYPE.SUBSCRIPTION_IN_GRACE_PERIOD
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
