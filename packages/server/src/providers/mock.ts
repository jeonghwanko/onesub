import { createHash } from 'node:crypto';
import type { SubscriptionInfo } from '@onesub/shared';
import { SUBSCRIPTION_STATUS, MOCK_RECEIPT_PREFIX } from '@onesub/shared';
import { log } from '../logger.js';

/**
 * Mock provider — returns deterministic receipt-validation results based on
 * the receipt string pattern. Used when `config.{apple,google}.mockMode` is
 * true so developers / CI / AI agents can exercise the full onesub flow
 * without App Store Connect or Play Developer API credentials.
 *
 * ──────────────────────────────────────────────────────────────────────
 *  Receipt prefix (see `MOCK_RECEIPT_PREFIX` in @onesub/shared)
 * ──────────────────────────────────────────────────────────────────────
 *  REVOKED         → null (revoked/refunded)
 *  EXPIRED         → null (> 72h old)
 *  INVALID / BAD_SIG → null (signature / integrity fail)
 *  NETWORK_ERROR   → throws (simulates upstream failure)
 *  SANDBOX         → valid; subscription has a shorter expiry (~1h)
 *  <anything else> → valid; transactionId = sha256(receipt)[:24]
 *
 * transactionId is derived from sha256(receipt) so the same receipt always
 * produces the same id — useful for replay / idempotency testing.
 */

export type MockReceiptOutcome =
  | { kind: 'valid' }
  | { kind: 'sandbox' }
  | { kind: 'revoked' }
  | { kind: 'expired' }
  | { kind: 'invalid' }
  | { kind: 'network-error' };

export function classifyMockReceipt(receipt: string): MockReceiptOutcome {
  if (receipt.startsWith(MOCK_RECEIPT_PREFIX.NETWORK_ERROR)) return { kind: 'network-error' };
  if (receipt.startsWith(MOCK_RECEIPT_PREFIX.REVOKED)) return { kind: 'revoked' };
  if (receipt.startsWith(MOCK_RECEIPT_PREFIX.EXPIRED)) return { kind: 'expired' };
  if (
    receipt.startsWith(MOCK_RECEIPT_PREFIX.INVALID) ||
    receipt.startsWith(MOCK_RECEIPT_PREFIX.BAD_SIG)
  ) {
    return { kind: 'invalid' };
  }
  if (receipt.startsWith(MOCK_RECEIPT_PREFIX.SANDBOX)) return { kind: 'sandbox' };
  return { kind: 'valid' };
}

/**
 * Gate the outcome against `valid` / `sandbox`. Throws for network-error,
 * logs + returns false for rejection cases, returns true for pass-through.
 * Every mock validator uses this so their rejection behavior stays in sync.
 */
function outcomePasses(outcome: MockReceiptOutcome, tag: string): boolean {
  if (outcome.kind === 'network-error') {
    throw new Error(`[onesub/mock/${tag}] simulated upstream network error`);
  }
  if (outcome.kind === 'valid' || outcome.kind === 'sandbox') return true;
  log.warn(`[onesub/mock/${tag}] receipt rejected`, { outcome: outcome.kind });
  return false;
}

function deterministicTransactionId(prefix: string, receipt: string): string {
  const digest = createHash('sha256').update(receipt).digest('hex').slice(0, 24);
  return `${prefix}_${digest}`;
}

const HOURS = 60 * 60 * 1000;
const DAYS = 24 * HOURS;

export function mockValidateAppleSubscription(receipt: string): SubscriptionInfo | null {
  const outcome = classifyMockReceipt(receipt);
  if (!outcomePasses(outcome, 'apple')) return null;
  const now = Date.now();
  const expiresAt = outcome.kind === 'sandbox' ? now + 1 * HOURS : now + 30 * DAYS;
  return {
    userId: '',
    productId: 'mock_subscription',
    platform: 'apple',
    status: SUBSCRIPTION_STATUS.ACTIVE,
    expiresAt: new Date(expiresAt).toISOString(),
    originalTransactionId: deterministicTransactionId('mock_apple_orig', receipt),
    purchasedAt: new Date(now).toISOString(),
    willRenew: true,
  };
}

export function mockValidateAppleProduct(
  receipt: string,
  expectedProductId?: string,
): { transactionId: string; productId: string; purchasedAt: string } | null {
  const outcome = classifyMockReceipt(receipt);
  if (!outcomePasses(outcome, 'apple')) return null;
  const productId = expectedProductId ?? 'mock_product';
  return {
    transactionId: deterministicTransactionId(`mock_apple_${productId}`, receipt),
    productId,
    purchasedAt: new Date().toISOString(),
  };
}

export function mockValidateGoogleSubscription(
  receipt: string,
  productId: string,
): SubscriptionInfo | null {
  const outcome = classifyMockReceipt(receipt);
  if (!outcomePasses(outcome, 'google')) return null;
  const now = Date.now();
  const expiresAt = outcome.kind === 'sandbox' ? now + 1 * HOURS : now + 30 * DAYS;
  return {
    userId: '',
    productId,
    platform: 'google',
    status: SUBSCRIPTION_STATUS.ACTIVE,
    expiresAt: new Date(expiresAt).toISOString(),
    originalTransactionId: deterministicTransactionId('mock_google_orig', receipt),
    purchasedAt: new Date(now).toISOString(),
    willRenew: true,
  };
}

export function mockValidateGoogleProduct(
  receipt: string,
  productId: string,
): { transactionId: string; purchasedAt: string } | null {
  const outcome = classifyMockReceipt(receipt);
  if (!outcomePasses(outcome, 'google')) return null;
  return {
    transactionId: deterministicTransactionId(`mock_google_${productId}`, receipt),
    purchasedAt: new Date().toISOString(),
  };
}
