import { decodeJwt, createRemoteJWKSet, jwtVerify } from 'jose';
import type { SubscriptionInfo, AppleNotificationPayload, OneSubServerConfig } from '@onesub/shared';
import { SUBSCRIPTION_STATUS } from '@onesub/shared';

type AppleConfig = NonNullable<OneSubServerConfig['apple']>;

/** Maximum age for consumable receipts (72 hours). Older receipts may indicate replay attacks. */
const MAX_CONSUMABLE_RECEIPT_AGE_MS = 72 * 60 * 60 * 1000;

/**
 * Decoded Apple signed transaction (JWS payload).
 * Mirrors the fields from App Store Server API / StoreKit 2.
 */
interface AppleTransactionPayload {
  bundleId?: string;
  productId?: string;
  originalTransactionId?: string;
  transactionId?: string;
  purchaseDate?: number;       // ms since epoch
  originalPurchaseDate?: number;
  expiresDate?: number;        // ms since epoch
  inAppOwnershipType?: string;
  type?: string;               // 'Auto-Renewable Subscription'
  isUpgraded?: boolean;
  revocationDate?: number;
  [key: string]: unknown;
}

/**
 * Decoded Apple signed renewal info (JWS payload).
 */
interface AppleRenewalPayload {
  autoRenewStatus?: number;    // 1 = will renew, 0 = canceled
  expirationIntent?: number;   // 1=Customer canceled, 2=Billing error, etc.
  originalTransactionId?: string;
  productId?: string;
  [key: string]: unknown;
}

/**
 * Module-level JWKS fetcher for Apple's public keys.
 * Cached automatically by jose's createRemoteJWKSet.
 */
const appleJWKS = createRemoteJWKSet(
  new URL('https://appleid.apple.com/auth/keys')
);

/**
 * Decode and verify a JWS compact serialisation using Apple's JWKS.
 * When skipVerification is true, falls back to decodeJwt() without signature
 * verification (useful for dev/testing environments).
 */
export async function decodeJws<T>(jws: string, skipVerification = false): Promise<T> {
  if (skipVerification) {
    if (process.env['NODE_ENV'] === 'production') {
      console.warn(
        '[onesub/apple] WARNING: skipJwsVerification is enabled in production. ' +
          'JWS signatures are NOT being verified. This is a security risk. ' +
          'Disable skipJwsVerification before going live.'
      );
    }
    // Dev/test path: decode payload only, no signature check
    return decodeJwt(jws) as T;
  }

  const { payload } = await jwtVerify(jws, appleJWKS);
  return payload as T;
}

/**
 * Derive a SubscriptionStatus from the transaction + renewal payloads.
 */
function deriveStatus(
  tx: AppleTransactionPayload,
  renewal: AppleRenewalPayload | null
): SubscriptionInfo['status'] {
  if (tx.revocationDate) return SUBSCRIPTION_STATUS.CANCELED;

  const now = Date.now();
  const expires = tx.expiresDate ?? 0;

  if (expires > now) return SUBSCRIPTION_STATUS.ACTIVE;

  // Expired — check if it was voluntarily canceled
  if (renewal?.autoRenewStatus === 0) return SUBSCRIPTION_STATUS.CANCELED;

  return SUBSCRIPTION_STATUS.EXPIRED;
}

/**
 * Validate an Apple receipt string.
 *
 * StoreKit 2 receipts are JWS-encoded signed transactions (the `signedTransaction`
 * field from the client). For legacy base64 receipts from StoreKit 1, you would
 * POST to verifyReceipt — that path is left as a stub here because Apple is
 * deprecating it.
 */
export async function validateAppleReceipt(
  receipt: string,
  config: AppleConfig
): Promise<SubscriptionInfo | null> {
  let tx: AppleTransactionPayload;

  try {
    // StoreKit 2: receipt is a signed JWS transaction
    tx = await decodeJws<AppleTransactionPayload>(receipt, config.skipJwsVerification);
  } catch {
    console.warn('[onesub/apple] Failed to decode receipt as JWS. Falling back to null.');
    return null;
  }

  if (!tx.originalTransactionId || !tx.productId || !tx.expiresDate) {
    return null;
  }

  // Validate bundle ID — missing or mismatched both rejected
  if (!tx.bundleId || tx.bundleId !== config.bundleId) {
    console.warn('[onesub/apple] Bundle ID mismatch:', tx.bundleId, '!==', config.bundleId);
    return null;
  }

  // Reject Sandbox receipts in production unless explicitly allowed.
  // Set ONESUB_ALLOW_SANDBOX=true to permit TestFlight sandbox receipts on
  // production servers (useful during QA before App Store release).
  if (
    process.env['NODE_ENV'] === 'production' &&
    tx.environment !== 'Production' &&
    process.env['ONESUB_ALLOW_SANDBOX'] !== 'true'
  ) {
    console.warn('[onesub/apple] Sandbox receipt rejected in production:', tx.environment);
    return null;
  }

  const status = deriveStatus(tx, null);
  const purchasedAt = tx.originalPurchaseDate ?? tx.purchaseDate ?? Date.now();

  return {
    userId: '',  // caller fills this in from the request body
    productId: tx.productId,
    platform: 'apple',
    status,
    expiresAt: new Date(tx.expiresDate).toISOString(),
    originalTransactionId: tx.originalTransactionId,
    purchasedAt: new Date(purchasedAt).toISOString(),
    willRenew: status === SUBSCRIPTION_STATUS.ACTIVE, // refined by renewal info in webhook
  };
}

/**
 * Result of validating an Apple consumable or non-consumable receipt.
 */
export interface AppleProductResult {
  /** Per-transaction unique ID (transactionId, not originalTransactionId) */
  transactionId: string;
  productId: string;
  purchasedAt: string;
}

/**
 * Validate an Apple StoreKit 2 JWS signedTransaction for a consumable or
 * non-consumable product.
 *
 * Differences from validateAppleReceipt (subscriptions):
 * - Checks tx.type is 'Consumable' or 'Non-Consumable' (not a subscription)
 * - Uses tx.transactionId (per-purchase unique) instead of originalTransactionId
 * - Enforces a 72-hour receipt age limit to block replay attacks
 * - Does NOT check expiresDate (one-time purchases don't expire)
 */
export async function validateAppleConsumableReceipt(
  signedTransaction: string,
  config: AppleConfig,
  expectedProductId?: string,
): Promise<AppleProductResult | null> {
  let tx: AppleTransactionPayload;

  try {
    tx = await decodeJws<AppleTransactionPayload>(signedTransaction, config.skipJwsVerification);
  } catch {
    console.warn('[onesub/apple] Failed to decode consumable JWS');
    return null;
  }

  // bundleId must be present and match
  if (!tx.bundleId || tx.bundleId !== config.bundleId) {
    console.warn('[onesub/apple] Bundle ID mismatch:', tx.bundleId, '!==', config.bundleId);
    return null;
  }

  // Must be a one-time purchase type (not a subscription)
  if (tx.type !== 'Consumable' && tx.type !== 'Non-Consumable') {
    console.warn('[onesub/apple] Invalid purchase type for product validation:', tx.type);
    return null;
  }

  // Reject Sandbox receipts in production unless explicitly allowed.
  // Set ONESUB_ALLOW_SANDBOX=true to permit TestFlight sandbox receipts on
  // production servers (useful during QA before App Store release).
  if (
    process.env['NODE_ENV'] === 'production' &&
    tx.environment !== 'Production' &&
    process.env['ONESUB_ALLOW_SANDBOX'] !== 'true'
  ) {
    console.warn('[onesub/apple] Sandbox receipt rejected in production:', tx.environment);
    return null;
  }

  if (!tx.productId) {
    console.warn('[onesub/apple] No productId in transaction');
    return null;
  }

  if (expectedProductId && tx.productId !== expectedProductId) {
    console.warn('[onesub/apple] Product ID mismatch:', tx.productId, '!==', expectedProductId);
    return null;
  }

  // Reject refunded purchases
  if (tx.revocationDate) {
    console.warn('[onesub/apple] Purchase was revoked/refunded');
    return null;
  }

  // Reject receipts older than 72 hours (replay attack prevention)
  if (tx.purchaseDate && Date.now() - tx.purchaseDate > MAX_CONSUMABLE_RECEIPT_AGE_MS) {
    console.warn('[onesub/apple] Consumable receipt too old (>72h)');
    return null;
  }

  // For consumables, transactionId is per-purchase unique.
  // originalTransactionId is shared across re-purchases, so it must not be used
  // as the deduplication key for consumables.
  const transactionId = tx.transactionId ?? tx.originalTransactionId;
  if (!transactionId) {
    console.warn('[onesub/apple] No transactionId in consumable transaction');
    return null;
  }

  return {
    transactionId,
    productId: tx.productId,
    purchasedAt: tx.purchaseDate
      ? new Date(tx.purchaseDate).toISOString()
      : new Date().toISOString(),
  };
}

/**
 * Decode an Apple Server Notification V2 payload.
 * Returns the derived subscription update to be merged into the store.
 */
export async function decodeAppleNotification(
  payload: AppleNotificationPayload,
  skipJwsVerification = false
): Promise<{ originalTransactionId: string; status: SubscriptionInfo['status']; willRenew: boolean; expiresAt: string } | null> {
  const { signedTransactionInfo, signedRenewalInfo } = payload.data;

  let tx: AppleTransactionPayload;
  let renewal: AppleRenewalPayload | null = null;

  try {
    tx = await decodeJws<AppleTransactionPayload>(signedTransactionInfo, skipJwsVerification);
  } catch {
    return null;
  }

  try {
    renewal = await decodeJws<AppleRenewalPayload>(signedRenewalInfo, skipJwsVerification);
  } catch {
    // renewal info is optional for some notification types
  }

  if (!tx.originalTransactionId || !tx.expiresDate) return null;

  const status = deriveStatus(tx, renewal);
  const willRenew = renewal?.autoRenewStatus === 1;

  return {
    originalTransactionId: tx.originalTransactionId,
    status,
    willRenew,
    expiresAt: new Date(tx.expiresDate).toISOString(),
  };
}
