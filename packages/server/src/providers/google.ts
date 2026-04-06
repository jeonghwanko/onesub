import type { SubscriptionInfo, GoogleNotificationPayload } from '@onesub/shared';

interface GoogleConfig {
  packageName: string;
  serviceAccountKey?: string;
}

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
 * Module-level token cache. Keyed by the raw serviceAccountKey string so that
 * different service accounts (rare but possible) are cached independently.
 */
let cachedToken: { token: string; expiresAt: number; key: string } | null = null;

/**
 * Obtain a Google OAuth2 access token, returning a cached token if it has more
 * than 60 seconds of remaining validity. Google tokens are valid for 3600 seconds,
 * so this avoids a network round-trip on every API call.
 */
async function getCachedAccessToken(serviceAccountKey: string): Promise<string> {
  const now = Date.now();
  if (
    cachedToken !== null &&
    cachedToken.key === serviceAccountKey &&
    cachedToken.expiresAt - now > 60_000
  ) {
    return cachedToken.token;
  }

  const token = await getAccessToken(serviceAccountKey);
  // Google tokens expire in 3600 s; store with a conservative margin already
  // accounted for in the read path (60 s buffer above).
  cachedToken = { token, expiresAt: now + 3600_000, key: serviceAccountKey };
  return token;
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
 * Derive a SubscriptionStatus from a Google Play purchase resource.
 */
function deriveStatus(purchase: GoogleSubscriptionPurchase): SubscriptionInfo['status'] {
  const now = Date.now();
  const expiryMs = purchase.expiryTimeMillis ? parseInt(purchase.expiryTimeMillis, 10) : 0;

  if (expiryMs > now) {
    // paymentState 0 = pending (grace period treated as active)
    return 'active';
  }

  if (purchase.cancelReason !== undefined) return 'canceled';

  return 'expired';
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
  if (!config.serviceAccountKey) {
    console.warn('[onesub/google] No serviceAccountKey provided — cannot call Play API');
    return null;
  }

  let purchase: GoogleSubscriptionPurchase;
  try {
    const token = await getCachedAccessToken(config.serviceAccountKey);
    purchase = await fetchSubscriptionPurchase(config.packageName, productId, receipt, token);
  } catch (err) {
    console.error('[onesub/google] Receipt validation failed:', err);
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
