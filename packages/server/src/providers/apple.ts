import { decodeJwt, decodeProtectedHeader, importPKCS8, importX509, jwtVerify, SignJWT } from 'jose';
import { X509Certificate } from 'node:crypto';
import type {
  SubscriptionInfo,
  AppleNotificationPayload,
  AppleConsumptionRequest,
  OneSubServerConfig,
} from '@onesub/shared';
import { SUBSCRIPTION_STATUS } from '@onesub/shared';
import { APPLE_ROOT_CA_PEMS } from './apple-root-ca.js';
import { log } from '../logger.js';
import { fetchWithTimeout } from '../http.js';
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
): Promise<{
  originalTransactionId: string;
  /** Per-transaction id (different from originalTransactionId for consumables / re-purchases). */
  transactionId: string | null;
  /** 'Auto-Renewable Subscription' | 'Consumable' | 'Non-Consumable' | 'Non-Renewing Subscription' */
  type: string | null;
  productId: string | null;
  bundleId: string | null;
  /** 'Production' | 'Sandbox' — drives which Apple API host to call back. */
  environment: 'Production' | 'Sandbox';
  status: SubscriptionInfo['status'];
  willRenew: boolean;
  /** May be null for non-subscription notifications (consumable refund). */
  expiresAt: string | null;
} | null> {
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

  // expiresDate is only required for subscription notifications.
  // Consumable / non-consumable refund notifications (REFUND for IAP) have no expiry.
  if (!tx.originalTransactionId) return null;

  const status = deriveStatus(tx, renewal);
  const willRenew = renewal?.autoRenewStatus === 1;

  // environment is on the notification data envelope but Apple also includes
  // it inside the signed transaction payload. Prefer the JWS-protected one.
  const txEnv = (tx as { environment?: string }).environment;
  const dataEnv = payload.data.environment;
  const environment: 'Production' | 'Sandbox' =
    txEnv === 'Sandbox' || dataEnv === 'Sandbox' ? 'Sandbox' : 'Production';

  return {
    originalTransactionId: tx.originalTransactionId,
    transactionId: tx.transactionId ?? null,
    type: tx.type ?? null,
    productId: tx.productId ?? null,
    bundleId: tx.bundleId ?? payload.data.bundleId ?? null,
    environment,
    status,
    willRenew,
    expiresAt: tx.expiresDate ? new Date(tx.expiresDate).toISOString() : null,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// App Store Server API — outbound calls (consumption response, etc.)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Module-level JWT cache for the App Store Server API. Apple caps token TTL
 * at 20 minutes; we mint with that TTL and re-use until 60 seconds before
 * expiry (so long-running webhook bursts don't pay the ECDSA-sign cost on
 * every request). Promise dedup prevents thundering-herd JWT mints when many
 * concurrent callers race the cache miss.
 *
 * Keyed by `${issuerId}|${keyId}` since rotating either invalidates the JWT.
 */
let cachedAppleJwt: { token: string; expiresAt: number; key: string } | null = null;
let appleJwtMintPromise: Promise<string> | null = null;

const APPLE_JWT_TTL_MS = 20 * 60 * 1000;
const APPLE_JWT_REFRESH_BEFORE_MS = 60 * 1000;

/**
 * Mint a JWT for the App Store Server API (audience `appstoreconnect-v1`).
 * Requires keyId, issuerId, and privateKey (PKCS8 ES256 from App Store Connect).
 * Token TTL is capped at 20 minutes per Apple's spec.
 */
async function makeAppleApiJwt(config: AppleConfig): Promise<string> {
  const { issuerId, keyId, privateKey, bundleId } = config;
  if (!issuerId || !keyId || !privateKey) {
    throw new Error('[onesub/apple] App Store Server API requires issuerId, keyId, and privateKey');
  }

  const cacheKey = `${issuerId}|${keyId}`;
  const now = Date.now();

  if (
    cachedAppleJwt &&
    cachedAppleJwt.key === cacheKey &&
    cachedAppleJwt.expiresAt - now > APPLE_JWT_REFRESH_BEFORE_MS
  ) {
    return cachedAppleJwt.token;
  }

  if (!appleJwtMintPromise) {
    appleJwtMintPromise = (async () => {
      const key = await importPKCS8(privateKey, 'ES256');
      const issuedAt = Math.floor(Date.now() / 1000);
      const token = await new SignJWT({ bid: bundleId })
        .setProtectedHeader({ alg: 'ES256', kid: keyId, typ: 'JWT' })
        .setIssuer(issuerId)
        .setAudience('appstoreconnect-v1')
        .setIssuedAt(issuedAt)
        .setExpirationTime(issuedAt + Math.floor(APPLE_JWT_TTL_MS / 1000))
        .sign(key);
      cachedAppleJwt = { token, expiresAt: Date.now() + APPLE_JWT_TTL_MS, key: cacheKey };
      return token;
    })().finally(() => {
      appleJwtMintPromise = null;
    });
  }

  return appleJwtMintPromise;
}

/** Test-only: clear the module-level Apple JWT cache. Not exported. */
function clearAppleJwtCacheForTests(): void {
  cachedAppleJwt = null;
  appleJwtMintPromise = null;
}
// Expose for the test suite without polluting the public API surface.
export const __testing = { clearAppleJwtCacheForTests };

/**
 * PUT a ConsumptionRequest to Apple's
 * /inApps/v1/transactions/consumption/{transactionId} endpoint.
 *
 * Apple sends CONSUMPTION_REQUEST notifications when a customer asks for a
 * refund on a consumable. Without a response Apple has no usage signal and
 * tends to grant the refund. This call provides the data Apple uses to weigh
 * the refund decision.
 *
 * Fire-and-forget: failures are logged, never thrown — the webhook should
 * still 200 to Apple even if our outbound call fails.
 */
export async function sendAppleConsumptionResponse(
  transactionId: string,
  body: AppleConsumptionRequest,
  config: AppleConfig,
  options?: { sandbox?: boolean },
): Promise<void> {
  if (config.mockMode) return;

  let jwt: string;
  try {
    jwt = await makeAppleApiJwt(config);
  } catch (err) {
    log.warn('[onesub/apple] Cannot send consumption response — JWT mint failed:', err);
    return;
  }

  const host = options?.sandbox
    ? 'api.storekit-sandbox.itunes.apple.com'
    : 'api.storekit.itunes.apple.com';
  const url = `https://${host}/inApps/v1/transactions/consumption/${encodeURIComponent(transactionId)}`;

  try {
    const resp = await fetchWithTimeout(url, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${jwt}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const text = await resp.text();
      log.warn(`[onesub/apple] Consumption response API error ${resp.status}: ${text}`);
    }
  } catch (err) {
    log.warn('[onesub/apple] Consumption response network error:', err);
  }
}

/**
 * Apple's status code in the GET /inApps/v1/subscriptions/{originalTxId} response.
 * https://developer.apple.com/documentation/appstoreserverapi/status
 */
const APPLE_SUBSCRIPTION_STATUS_CODE = {
  ACTIVE: 1,
  EXPIRED: 2,
  BILLING_RETRY: 3,
  GRACE_PERIOD: 4,
  REVOKED: 5,
} as const;

function mapAppleStatusCode(code: number): SubscriptionInfo['status'] {
  switch (code) {
    case APPLE_SUBSCRIPTION_STATUS_CODE.ACTIVE:
      return SUBSCRIPTION_STATUS.ACTIVE;
    case APPLE_SUBSCRIPTION_STATUS_CODE.GRACE_PERIOD:
      return SUBSCRIPTION_STATUS.GRACE_PERIOD;
    case APPLE_SUBSCRIPTION_STATUS_CODE.BILLING_RETRY:
      return SUBSCRIPTION_STATUS.ON_HOLD;
    case APPLE_SUBSCRIPTION_STATUS_CODE.REVOKED:
      return SUBSCRIPTION_STATUS.CANCELED;
    case APPLE_SUBSCRIPTION_STATUS_CODE.EXPIRED:
    default:
      return SUBSCRIPTION_STATUS.EXPIRED;
  }
}

/**
 * Shape of the GET /inApps/v1/subscriptions/{originalTransactionId} response.
 * Only the fields we read.
 */
interface AppleSubscriptionStatusResponse {
  data?: Array<{
    subscriptionGroupIdentifier?: string;
    lastTransactions?: Array<{
      originalTransactionId?: string;
      status?: number;
      signedTransactionInfo?: string;
      signedRenewalInfo?: string;
    }>;
  }>;
  bundleId?: string;
  environment?: 'Production' | 'Sandbox';
}

/**
 * Fetch the current state of a subscription directly from Apple's App Store
 * Server API — the canonical source of truth when webhooks have been missed,
 * delivered out of order, or the local store has no record at all.
 *
 * GET /inApps/v1/subscriptions/{originalTransactionId}
 * https://developer.apple.com/documentation/appstoreserverapi/get_all_subscription_statuses
 *
 * Returns null on:
 *   - Missing API credentials (issuerId/keyId/privateKey)
 *   - Network or auth failure
 *   - Empty response (transaction not found)
 *
 * Hosts can call this directly (e.g. from a reconciliation cron) or it runs
 * automatically as the unknown-transaction fallback inside the Apple webhook.
 */
export async function fetchAppleSubscriptionStatus(
  originalTransactionId: string,
  config: AppleConfig,
  options?: { sandbox?: boolean },
): Promise<SubscriptionInfo | null> {
  if (config.mockMode) return null;

  let jwt: string;
  try {
    jwt = await makeAppleApiJwt(config);
  } catch (err) {
    log.warn('[onesub/apple] Cannot fetch subscription status — JWT mint failed:', err);
    return null;
  }

  const host = options?.sandbox
    ? 'api.storekit-sandbox.itunes.apple.com'
    : 'api.storekit.itunes.apple.com';
  const url = `https://${host}/inApps/v1/subscriptions/${encodeURIComponent(originalTransactionId)}`;

  let body: AppleSubscriptionStatusResponse;
  try {
    const resp = await fetchWithTimeout(url, {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    if (!resp.ok) {
      const text = await resp.text();
      log.warn(`[onesub/apple] Status API error ${resp.status}: ${text}`);
      return null;
    }
    body = (await resp.json()) as AppleSubscriptionStatusResponse;
  } catch (err) {
    log.warn('[onesub/apple] Status API network error:', err);
    return null;
  }

  // Find the lastTransactions entry matching the requested originalTransactionId.
  // Apple groups by subscriptionGroupIdentifier; one originalTxId is in exactly one group.
  const entry = body.data
    ?.flatMap((g) => g.lastTransactions ?? [])
    .find((t) => t.originalTransactionId === originalTransactionId);

  if (!entry || entry.status == null || !entry.signedTransactionInfo) {
    log.warn('[onesub/apple] Status API returned no matching transaction for', originalTransactionId);
    return null;
  }

  let tx: AppleTransactionPayload;
  try {
    tx = await decodeJws<AppleTransactionPayload>(entry.signedTransactionInfo, config.skipJwsVerification);
  } catch (err) {
    log.warn('[onesub/apple] Failed to decode signedTransactionInfo from Status API:', err);
    return null;
  }

  let renewal: AppleRenewalPayload | null = null;
  if (entry.signedRenewalInfo) {
    try {
      renewal = await decodeJws<AppleRenewalPayload>(entry.signedRenewalInfo, config.skipJwsVerification);
    } catch {
      // renewal info is optional
    }
  }

  if (!tx.productId || !tx.expiresDate) {
    log.warn('[onesub/apple] Status API transaction missing productId or expiresDate');
    return null;
  }

  const status = mapAppleStatusCode(entry.status);
  const purchasedAt = tx.originalPurchaseDate ?? tx.purchaseDate ?? Date.now();

  return {
    userId: '',  // caller fills this in
    productId: tx.productId,
    platform: 'apple',
    status,
    expiresAt: new Date(tx.expiresDate).toISOString(),
    originalTransactionId,
    purchasedAt: new Date(purchasedAt).toISOString(),
    willRenew: renewal?.autoRenewStatus === 1,
  };
}
