import { decodeJwt, decodeProtectedHeader, importX509, jwtVerify } from 'jose';
import { X509Certificate } from 'node:crypto';
import type { SubscriptionInfo, AppleNotificationPayload, OneSubServerConfig } from '@onesub/shared';
import { SUBSCRIPTION_STATUS } from '@onesub/shared';
import { APPLE_ROOT_CA_PEMS } from './apple-root-ca.js';
import { log } from '../logger.js';
import {
  mockValidateAppleSubscription,
  mockValidateAppleProduct,
} from './mock.js';

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

function derBase64ToPem(der: string): string {
  return (
    '-----BEGIN CERTIFICATE-----\n' +
    (der.match(/.{1,64}/g) ?? []).join('\n') +
    '\n-----END CERTIFICATE-----'
  );
}

const APPLE_ROOT_CERTS = APPLE_ROOT_CA_PEMS.map((pem) => new X509Certificate(pem));

/**
 * Validate that the x5c chain from the JWS terminates at one of Apple's
 * bundled root CAs. Each cert in the chain must be signed by the next (or
 * the bundled root), and all certs must currently be within their validity
 * window.
 *
 * Returns the leaf certificate PEM on success. Throws on any failure.
 */
function verifyAppleCertChain(x5c: string[]): string {
  if (x5c.length === 0) {
    throw new Error('[onesub/apple] empty x5c');
  }

  const chain = x5c.map((der) => new X509Certificate(derBase64ToPem(der)));
  const now = new Date();

  // Validity window + leaf→intermediate→... signature chain
  for (let i = 0; i < chain.length; i++) {
    const cert = chain[i];
    if (new Date(cert.validFrom) > now || new Date(cert.validTo) < now) {
      throw new Error(`[onesub/apple] cert[${i}] outside validity window`);
    }
    if (i + 1 < chain.length) {
      if (!cert.checkIssued(chain[i + 1]) || !cert.verify(chain[i + 1].publicKey)) {
        throw new Error(`[onesub/apple] cert[${i}] not signed by cert[${i + 1}]`);
      }
    }
  }

  // Final cert in chain (typically intermediate) must be signed by an Apple root.
  // Accept either (a) explicit signature match or (b) the cert itself being one
  // of our bundled Apple roots (happens when Apple embeds the full chain).
  const top = chain[chain.length - 1];
  const topDer = top.raw.toString('base64');
  const trustsRoot = APPLE_ROOT_CERTS.some((root) => {
    if (root.raw.toString('base64') === topDer) return true;
    if (!top.checkIssued(root)) return false;
    try { return top.verify(root.publicKey); } catch { return false; }
  });
  if (!trustsRoot) {
    throw new Error('[onesub/apple] cert chain does not terminate at a trusted Apple root');
  }

  return chain[0].toString();
}

/**
 * Decode and verify a StoreKit 2 signed transaction JWS.
 *
 * 1. Extract the x5c certificate chain from the JWS header.
 * 2. Validate the chain terminates at a bundled Apple Root CA (G3).
 * 3. Use the leaf certificate's public key to verify the JWS signature.
 *
 * skipVerification=true skips all of the above and just decodes the payload
 * (dev/test only).
 */
export async function decodeJws<T>(jws: string, skipVerification = false): Promise<T> {
  if (skipVerification) {
    if (process.env['NODE_ENV'] === 'production') {
      log.warn(
        '[onesub/apple] WARNING: skipJwsVerification is enabled in production. ' +
          'JWS signatures are NOT being verified. This is a security risk.',
      );
    }
    return decodeJwt(jws) as T;
  }

  const header = decodeProtectedHeader(jws) as { x5c?: string[]; alg?: string };
  const x5c = header.x5c;
  if (!x5c || x5c.length === 0) {
    throw new Error('[onesub/apple] JWS header missing x5c certificate chain');
  }

  const leafPem = verifyAppleCertChain(x5c);
  const alg = header.alg ?? 'ES256';
  const key = await importX509(leafPem, alg);

  const { payload } = await jwtVerify(jws, key);
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
  if (config.mockMode) return mockValidateAppleSubscription(receipt);
  let tx: AppleTransactionPayload;

  try {
    tx = await decodeJws<AppleTransactionPayload>(receipt, config.skipJwsVerification);
  } catch (err) {
    const preview = receipt.slice(0, 60);
    const parts = receipt.split('.').length;
    log.warn(
      '[onesub/apple] Failed to decode receipt as JWS:',
      (err as Error)?.message ?? err,
      `| preview: "${preview}..." (len=${receipt.length}, parts=${parts})`,
    );
    return null;
  }

  if (!tx.originalTransactionId || !tx.productId || !tx.expiresDate) {
    return null;
  }

  // Validate bundle ID — missing or mismatched both rejected
  if (!tx.bundleId || tx.bundleId !== config.bundleId) {
    log.warn('[onesub/apple] Bundle ID mismatch:', tx.bundleId, '!==', config.bundleId);
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
    log.warn('[onesub/apple] Sandbox receipt rejected in production:', tx.environment);
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
  if (config.mockMode) return mockValidateAppleProduct(signedTransaction, expectedProductId);
  let tx: AppleTransactionPayload;

  try {
    tx = await decodeJws<AppleTransactionPayload>(signedTransaction, config.skipJwsVerification);
  } catch (err) {
    const preview = signedTransaction.slice(0, 60);
    const parts = signedTransaction.split('.').length;
    const looksLikeJws = parts === 3;
    log.warn(
      '[onesub/apple] Failed to decode consumable JWS:',
      (err as Error)?.message ?? err,
      `| receipt preview: "${preview}..." (len=${signedTransaction.length}, parts=${parts}, looksLikeJws=${looksLikeJws})`,
    );
    return null;
  }

  // bundleId must be present and match
  if (!tx.bundleId || tx.bundleId !== config.bundleId) {
    log.warn('[onesub/apple] Bundle ID mismatch:', tx.bundleId, '!==', config.bundleId);
    return null;
  }

  // Must be a one-time purchase type (not a subscription)
  if (tx.type !== 'Consumable' && tx.type !== 'Non-Consumable') {
    log.warn('[onesub/apple] Invalid purchase type for product validation:', tx.type);
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
    log.warn('[onesub/apple] Sandbox receipt rejected in production:', tx.environment);
    return null;
  }

  if (!tx.productId) {
    log.warn('[onesub/apple] No productId in transaction');
    return null;
  }

  if (expectedProductId && tx.productId !== expectedProductId) {
    log.warn('[onesub/apple] Product ID mismatch:', tx.productId, '!==', expectedProductId);
    return null;
  }

  // Reject refunded purchases
  if (tx.revocationDate) {
    log.warn('[onesub/apple] Purchase was revoked/refunded');
    return null;
  }

  // Reject receipts older than 72 hours (replay attack prevention)
  if (tx.purchaseDate && Date.now() - tx.purchaseDate > MAX_CONSUMABLE_RECEIPT_AGE_MS) {
    log.warn('[onesub/apple] Consumable receipt too old (>72h)');
    return null;
  }

  // For consumables, transactionId is per-purchase unique.
  // originalTransactionId is shared across re-purchases, so it must not be used
  // as the deduplication key for consumables.
  const transactionId = tx.transactionId ?? tx.originalTransactionId;
  if (!transactionId) {
    log.warn('[onesub/apple] No transactionId in consumable transaction');
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
