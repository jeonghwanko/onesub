/**
 * Purchase event handling — extracted from OneSubProvider so the core logic
 * is directly unit-testable without rendering React.
 *
 * The Provider owns lifecycle (mount/unmount, React state) and wires these
 * helpers into `purchaseUpdatedListener`. Every unit of behavior here is
 * pure except for the injected dependencies.
 */

import type { OneSubConfig, SubscriptionInfo, PurchaseInfo, PurchaseType, OneSubErrorCode } from '@onesub/shared';
import { PURCHASE_TYPE, ONESUB_ERROR_CODE } from '@onesub/shared';
import { OneSubError, isOneSubErrorCode } from './OneSubError.js';

export type InFlightEntry = {
  kind: 'subscription' | 'purchase';
  purchaseType?: 'consumable' | 'non_consumable';
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
};

export type Platform = 'ios' | 'android';

/**
 * Dependencies the event handler needs. Injecting rather than importing makes
 * the handler trivially mockable in tests.
 */
export interface PurchaseFlowDeps {
  config: OneSubConfig;
  userId: string;
  platform: Platform;
  inFlight: Map<string, InFlightEntry>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  RNIap: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  api: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    validateReceipt: (serverUrl: string, body: any) => Promise<any>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    validatePurchase: (serverUrl: string, body: any) => Promise<any>;
  };
  onSubscriptionActivated?: (subscription: SubscriptionInfo) => void;
  isCancelled?: () => boolean;
  /**
   * When false, this event is treated as an orphan replay no matter what —
   * in-flight matching is suppressed. Used during the mount drain window to
   * prevent a queued StoreKit redelivery from resolving a user-initiated
   * promise that happens to target the same productId.
   *
   * Rationale: StoreKit's `Transaction.updates` may deliver pending
   * transactions asynchronously in the first few hundred milliseconds after
   * listener attach. If the user taps Subscribe during that window, the
   * in-flight entry is already registered and would match the replay — the
   * classic "no sheet, immediately restored" bug.
   *
   * Default (undefined) is treated as true (matching enabled).
   */
  allowInFlightMatching?: () => boolean;
}

/** Normalize a server `errorCode` field; unknown strings → fallback. */
function serverErrorCode(code: unknown, fallback: OneSubErrorCode): OneSubErrorCode {
  return isOneSubErrorCode(code) ? code : fallback;
}

export function extractReceiptToken(purchase: unknown): string {
  if (!purchase || typeof purchase !== 'object') return '';
  const p = purchase as Record<string, unknown>;
  if (typeof p.purchaseToken === 'string' && p.purchaseToken.length > 0) {
    return p.purchaseToken;
  }
  if (typeof p.transactionReceipt === 'string' && p.transactionReceipt.length > 0) {
    return p.transactionReceipt;
  }
  return '';
}

/**
 * Decide whether this event describes a subscription. Priority:
 *   1. The caller's in-flight entry (user just tapped Subscribe vs Purchase)
 *   2. The Purchase object's `productType` field set by react-native-iap v15
 *
 * Orphan replay events without in-flight MUST rely on (2) — we can't guess.
 * Falling back to "subscription" would cause validatePurchase-bound consumables
 * to hit the subscription validator.
 */
export function isSubscriptionEvent(
  purchase: { productType?: unknown },
  inFlight: InFlightEntry | undefined,
): boolean {
  if (inFlight) return inFlight.kind === 'subscription';
  const t = purchase.productType;
  if (typeof t !== 'string') return false;
  // v15 / OpenIAP surfaces types 'subs' | 'inapp'; legacy variants observed
  // in sandbox include 'auto-renewable' and 'auto_renewable_subscription'.
  return t === 'subs' || t.includes('subs') || t.includes('renewable');
}

/**
 * Process a single purchase event (either a fresh transaction or a replay
 * delivered by Transaction.updates at connection time). Validates with the
 * server, finishes the transaction on success, and resolves/rejects the
 * matching in-flight promise if one exists.
 *
 * ORPHAN events (no in-flight entry) are legitimate — they happen when the
 * StoreKit queue had unfinished transactions at mount. We still validate +
 * finish them; the server idempotency (`action: 'restored'`) keeps this safe.
 * Updates to `isActive` happen via `onSubscriptionActivated`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function handlePurchaseEvent(purchase: any, deps: PurchaseFlowDeps): Promise<void> {
  if (!purchase || !purchase.productId) return;
  const productId: string = purchase.productId;
  // Respect the caller's drain-window gate: during the first few hundred ms
  // after listener attach, StoreKit may still be flushing queued replays.
  // Pretend there's no in-flight match so those replays are silently drained
  // even when they happen to target the same productId the user just tapped.
  const matchingAllowed = deps.allowInFlightMatching ? deps.allowInFlightMatching() : true;
  const inFlight = matchingAllowed ? deps.inFlight.get(productId) : undefined;

  const receiptToken = extractReceiptToken(purchase);
  if (!receiptToken) {
    inFlight?.reject(new OneSubError(ONESUB_ERROR_CODE.NO_RECEIPT_DATA, '[onesub] No receipt data in purchase event.'));
    deps.inFlight.delete(productId);
    return;
  }

  const platformName = deps.platform === 'ios' ? 'apple' : 'google';
  const isSubscription = isSubscriptionEvent(purchase, inFlight);

  try {
    if (isSubscription) {
      const result = await deps.api.validateReceipt(deps.config.serverUrl, {
        platform: platformName,
        receipt: receiptToken,
        userId: deps.userId,
        productId,
      });
      if (!deps.isCancelled?.() && result.valid && result.subscription) {
        deps.onSubscriptionActivated?.(result.subscription);
      }
      if (result.valid) {
        await deps.RNIap.finishTransaction({ purchase, isConsumable: false }).catch(() => {
          /* ignore */
        });
        inFlight?.resolve(result);
      } else {
        // Don't finish — server rejected; let StoreKit replay next launch.
        const code = serverErrorCode(result.errorCode, ONESUB_ERROR_CODE.RECEIPT_VALIDATION_FAILED);
        inFlight?.reject(new OneSubError(code, result.error ?? '[onesub] Receipt validation failed.'));
      }
    } else {
      const purchaseType: PurchaseType =
        inFlight?.purchaseType === 'consumable'
          ? PURCHASE_TYPE.CONSUMABLE
          : PURCHASE_TYPE.NON_CONSUMABLE;
      const result = await deps.api.validatePurchase(deps.config.serverUrl, {
        platform: platformName,
        receipt: receiptToken,
        userId: deps.userId,
        productId,
        type: purchaseType,
      });
      if (result.valid) {
        await deps.RNIap.finishTransaction({
          purchase,
          isConsumable: purchaseType === PURCHASE_TYPE.CONSUMABLE,
        }).catch(() => {
          /* ignore */
        });
        inFlight?.resolve(result);
      } else if (result.error === 'NON_CONSUMABLE_ALREADY_OWNED') {
        await deps.RNIap.finishTransaction({ purchase, isConsumable: false }).catch(() => {
          /* ignore */
        });
        inFlight?.resolve({
          valid: true,
          purchase: { productId, userId: deps.userId, platform: platformName, type: purchaseType } as PurchaseInfo,
          action: 'restored',
        });
      } else {
        const code = serverErrorCode(result.errorCode, ONESUB_ERROR_CODE.RECEIPT_VALIDATION_FAILED);
        inFlight?.reject(new OneSubError(code, result.error ?? '[onesub] Purchase validation failed.'));
      }
    }
  } catch (err) {
    inFlight?.reject(err instanceof OneSubError
      ? err
      : new OneSubError(
          ONESUB_ERROR_CODE.INTERNAL_ERROR,
          err instanceof Error ? err.message : String(err),
          err,
        ));
  } finally {
    // Only clear the in-flight slot when we actually consumed it. If matching
    // was suppressed (drain window) we must leave the user's entry intact so
    // a subsequent fresh event can still resolve it.
    if (inFlight) deps.inFlight.delete(productId);
  }
}

/**
 * Register an in-flight slot for a productId and return a promise that
 * resolves when `handlePurchaseEvent` sees the matching event.
 */
export function registerInFlight<T>(
  inFlight: Map<string, InFlightEntry>,
  productId: string,
  kind: 'subscription' | 'purchase',
  purchaseType: 'consumable' | 'non_consumable' | undefined,
  timeoutMs = 180_000,
): Promise<T> {
  if (inFlight.has(productId)) {
    return Promise.reject(new OneSubError(
      ONESUB_ERROR_CODE.CONCURRENT_PURCHASE,
      `[onesub] A purchase for ${productId} is already in progress.`,
    ));
  }
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (inFlight.get(productId)) {
        inFlight.delete(productId);
        reject(new OneSubError(ONESUB_ERROR_CODE.PURCHASE_TIMEOUT, '[onesub] Purchase timed out'));
      }
    }, timeoutMs);
    inFlight.set(productId, {
      kind,
      purchaseType,
      resolve: (v) => { clearTimeout(timer); resolve(v as T); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
  });
}
