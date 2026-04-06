import { decodeJwt } from 'jose';
import type { SubscriptionInfo, AppleNotificationPayload } from '@onesub/shared';

interface AppleConfig {
  bundleId: string;
  sharedSecret?: string;
  keyId?: string;
  issuerId?: string;
  privateKey?: string;
}

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
 * Decode a JWS compact serialisation without verifying the signature.
 * For production, integrate with Apple's public keys via JWKS to verify.
 */
function decodeJws<T>(jws: string): T {
  // jose decodeJwt reads only the payload section — no signature verification.
  // For production, use jose's compactVerify with Apple's JWKS endpoint:
  // https://appleid.apple.com/auth/keys
  return decodeJwt(jws) as T;
}

/**
 * Derive a SubscriptionStatus from the transaction + renewal payloads.
 */
function deriveStatus(
  tx: AppleTransactionPayload,
  renewal: AppleRenewalPayload | null
): SubscriptionInfo['status'] {
  if (tx.revocationDate) return 'canceled';

  const now = Date.now();
  const expires = tx.expiresDate ?? 0;

  if (expires > now) return 'active';

  // Expired — check if it was voluntarily canceled
  if (renewal?.autoRenewStatus === 0) return 'canceled';

  return 'expired';
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
    tx = decodeJws<AppleTransactionPayload>(receipt);
  } catch {
    console.warn('[onesub/apple] Failed to decode receipt as JWS. Falling back to null.');
    return null;
  }

  if (!tx.originalTransactionId || !tx.productId || !tx.expiresDate) {
    return null;
  }

  // Validate bundle ID if provided
  if (tx.bundleId && tx.bundleId !== config.bundleId) {
    console.warn('[onesub/apple] Bundle ID mismatch:', tx.bundleId, '!==', config.bundleId);
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
    willRenew: status === 'active', // refined by renewal info in webhook
  };
}

/**
 * Decode an Apple Server Notification V2 payload.
 * Returns the derived subscription update to be merged into the store.
 */
export function decodeAppleNotification(
  payload: AppleNotificationPayload
): { originalTransactionId: string; status: SubscriptionInfo['status']; willRenew: boolean; expiresAt: string } | null {
  const { signedTransactionInfo, signedRenewalInfo } = payload.data;

  let tx: AppleTransactionPayload;
  let renewal: AppleRenewalPayload | null = null;

  try {
    tx = decodeJws<AppleTransactionPayload>(signedTransactionInfo);
  } catch {
    return null;
  }

  try {
    renewal = decodeJws<AppleRenewalPayload>(signedRenewalInfo);
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
