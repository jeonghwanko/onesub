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
import type { SdkLogger } from './logger.js';

export type InFlightEntry = {
  kind: 'subscription' | 'purchase';
  purchaseType?: 'consumable' | 'non_consumable';
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  /** Handle of the registration timeout — cleared on settle or clearInFlight. */
  timer?: ReturnType<typeof setTimeout>;
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
  logger?: SdkLogger;
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
 * Pull the store transaction id from a raw react-native-iap purchase object.
 * On iOS this is the StoreKit transactionId; on Android the Google order id.
 * v15 / OpenIAP surfaces `transactionId`; `id` is the newer OpenIAP alias and
 * `orderId` the legacy Android field — try them in order. Returns '' if none.
 */
export function extractTransactionId(purchase: unknown): string {
  if (!purchase || typeof purchase !== 'object') return '';
  const p = purchase as Record<string, unknown>;
  for (const k of ['transactionId', 'id', 'orderId'] as const) {
    const v = p[k];
    if (typeof v === 'string' && v.length > 0) return v;
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
 * Decide whether a non-subscription event is consumable. Priority:
 *   1. The caller's in-flight entry — a user-initiated `purchaseProduct()` said
 *      so explicitly, and nothing beats that.
 *   2. `config.consumableProductIds` — the host's declaration, the only source
 *      an ORPHAN REPLAY has. A store transaction carries no consumable flag.
 *   3. `non_consumable` — the historical default.
 *
 * Step 2 exists because guessing at step 3 is silently destructive for a
 * consumable: the server records the wrong `type` (host reconciliation by type
 * never finds the purchase — paid, never granted) and `finishTransaction`
 * acknowledges instead of consuming (on Android the SKU stays owned forever, so
 * the user cannot rebuy). Neither surfaces as an error. Hosts that sell
 * consumables must declare them; hosts that do not are unaffected.
 */
export function resolvePurchaseType(
  productId: string,
  inFlight: InFlightEntry | undefined,
  config: Pick<OneSubConfig, 'consumableProductIds'>,
): PurchaseType {
  if (inFlight?.purchaseType) {
    return inFlight.purchaseType === 'consumable'
      ? PURCHASE_TYPE.CONSUMABLE
      : PURCHASE_TYPE.NON_CONSUMABLE;
  }
  return config.consumableProductIds?.includes(productId)
    ? PURCHASE_TYPE.CONSUMABLE
    : PURCHASE_TYPE.NON_CONSUMABLE;
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
  if (!purchase || !purchase.productId) {
    deps.logger?.trace('event ignored: missing productId');
    return;
  }
  const productId: string = purchase.productId;
  // Respect the caller's drain-window gate: during the first few hundred ms
  // after listener attach, StoreKit may still be flushing queued replays.
  // Pretend there's no in-flight match so those replays are silently drained
  // even when they happen to target the same productId the user just tapped.
  const matchingAllowed = deps.allowInFlightMatching ? deps.allowInFlightMatching() : true;
  const hasInFlight = deps.inFlight.has(productId);
  const inFlight = matchingAllowed ? deps.inFlight.get(productId) : undefined;
  deps.logger?.trace('event received', {
    productId,
    transactionId: purchase.transactionId,
    productType: purchase.productType,
    hasInFlight,
    matchingAllowed,
    matched: Boolean(inFlight),
  });

  const receiptToken = extractReceiptToken(purchase);
  if (!receiptToken) {
    deps.logger?.warn('event rejected: no receipt', { productId });
    inFlight?.reject(new OneSubError(ONESUB_ERROR_CODE.NO_RECEIPT_DATA, '[onesub] No receipt data in purchase event.'));
    // Same invariant as the settle path below: only clear the slot we actually
    // consumed. A suppressed-window replay (matching disabled → inFlight is
    // undefined even though the map has an entry) must leave the user's live
    // entry intact so a subsequent fresh event can still settle it. reject()
    // above already cleared the entry's timer, so a bare delete is safe here.
    if (inFlight) deps.inFlight.delete(productId);
    return;
  }

  const platformName = deps.platform === 'ios' ? 'apple' : 'google';
  const isSubscription = isSubscriptionEvent(purchase, inFlight);
  deps.logger?.trace('validating', { productId, platform: platformName, kind: isSubscription ? 'subscription' : 'purchase' });

  try {
    if (isSubscription) {
      const result = await deps.api.validateReceipt(deps.config.serverUrl, {
        platform: platformName,
        receipt: receiptToken,
        userId: deps.userId,
        productId,
        ...(deps.config.appId ? { appId: deps.config.appId } : {}),
      });
      if (!deps.isCancelled?.() && result.valid && result.subscription) {
        deps.onSubscriptionActivated?.(result.subscription);
      }
      if (result.valid) {
        deps.logger?.trace('subscription validated', { productId, action: result.action, active: Boolean(result.subscription) });
        // A matched caller may show its success UI as soon as this exact
        // in-flight transaction has passed server validation. StoreKit cleanup
        // still runs to completion and is surfaced separately so the Provider
        // can keep all other IAP mutations locked until it is safe to proceed.
        // Orphan replays have no in-flight caller and therefore remain silent.
        const finishStartedAt = Date.now();
        const cleanup = Promise.resolve()
          .then(() => deps.RNIap.finishTransaction({ purchase, isConsumable: false }))
          .then(() => {
            deps.logger?.trace('subscription transaction finished', {
              productId,
              durationMs: Date.now() - finishStartedAt,
            });
          })
          .catch((err: unknown) => {
            // The server already accepted the receipt. Leaving the transaction
            // unfinished is recoverable: StoreKit will replay it and the server
            // validation route is idempotent.
            deps.logger?.warn('subscription finishTransaction failed; transaction will replay', err);
          });
        inFlight?.resolve({ ...result, cleanup });
        await cleanup;
      } else {
        // Don't finish — server rejected; let StoreKit replay next launch.
        const code = serverErrorCode(result.errorCode, ONESUB_ERROR_CODE.RECEIPT_VALIDATION_FAILED);
        deps.logger?.warn('subscription rejected by server', { productId, code, error: result.error });
        inFlight?.reject(new OneSubError(code, result.error ?? '[onesub] Receipt validation failed.'));
      }
    } else {
      const purchaseType = resolvePurchaseType(productId, inFlight, deps.config);
      const result = await deps.api.validatePurchase(deps.config.serverUrl, {
        platform: platformName,
        receipt: receiptToken,
        userId: deps.userId,
        productId,
        type: purchaseType,
        ...(deps.config.appId ? { appId: deps.config.appId } : {}),
      });
      if (result.valid) {
        deps.logger?.trace('purchase validated', { productId, action: result.action, type: purchaseType });
        await deps.RNIap.finishTransaction({
          purchase,
          isConsumable: purchaseType === PURCHASE_TYPE.CONSUMABLE,
        }).catch(() => {
          /* ignore */
        });
        inFlight?.resolve(result);
      } else if (result.error === 'NON_CONSUMABLE_ALREADY_OWNED') {
        // Defensive fallback for servers still returning the legacy 409 instead
        // of an idempotent `restored` success (see server purchase route). Carry
        // the store transactionId through — an object missing it violates the
        // PurchaseInfo contract and breaks hosts that re-entitle off
        // `result.transactionId` (the user gets charged but never granted).
        const transactionId = extractTransactionId(purchase);
        deps.logger?.trace('purchase synthesized as restored (already owned)', { productId, transactionId });
        // Finish with the resolved type, not a hardcoded false. If the host
        // declared this id consumable, acknowledging it would leave the SKU
        // owned on Android and permanently block repurchase — the same trap
        // resolvePurchaseType exists to close.
        await deps.RNIap.finishTransaction({
          purchase,
          isConsumable: purchaseType === PURCHASE_TYPE.CONSUMABLE,
        }).catch(() => {
          /* ignore */
        });
        inFlight?.resolve({
          valid: true,
          purchase: {
            productId,
            userId: deps.userId,
            platform: platformName,
            type: purchaseType,
            transactionId,
            purchasedAt: new Date().toISOString(),
            quantity: 1,
          } satisfies PurchaseInfo,
          action: 'restored',
        });
      } else {
        const code = serverErrorCode(result.errorCode, ONESUB_ERROR_CODE.RECEIPT_VALIDATION_FAILED);
        deps.logger?.warn('purchase rejected by server', { productId, code, error: result.error });
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
    const entry: InFlightEntry = {
      kind,
      purchaseType,
      resolve: (v) => { clearTimeout(entry.timer); resolve(v as T); },
      reject: (e) => { clearTimeout(entry.timer); reject(e); },
    };
    entry.timer = setTimeout(() => {
      // Only act on the entry this timer was created for. A stale timer
      // (entry externally cleared, then the same productId re-registered)
      // must not delete the retry's fresh entry — that would leave its
      // promise unsettled forever and the Provider stuck busy.
      if (inFlight.get(productId) === entry) {
        inFlight.delete(productId);
        reject(new OneSubError(ONESUB_ERROR_CODE.PURCHASE_TIMEOUT, '[onesub] Purchase timed out'));
      }
    }, timeoutMs);
    inFlight.set(productId, entry);
  });
}

/**
 * Remove an in-flight slot WITHOUT settling its promise, clearing the
 * registration timeout so the stale timer can't fire later. Use this on the
 * paths that abandon a registration (e.g. requestPurchase threw before any
 * store event could arrive) — settling paths go through entry.resolve/reject,
 * which clear the timer themselves.
 */
export function clearInFlight(inFlight: Map<string, InFlightEntry>, productId: string): void {
  const entry = inFlight.get(productId);
  if (!entry) return;
  clearTimeout(entry.timer);
  inFlight.delete(productId);
}

/**
 * True when the error represents the user dismissing the purchase sheet —
 * either a raw react-native-iap error code or the SDK's own OneSubError
 * (the Provider's purchaseErrorListener rejects in-flight promises with
 * ONESUB_ERROR_CODE.USER_CANCELLED). Cancels are a normal outcome, not a
 * failure — callers return instead of throwing.
 */
export function isUserCancelled(err: unknown): boolean {
  if (err instanceof OneSubError) {
    return err.code === ONESUB_ERROR_CODE.USER_CANCELLED;
  }
  if (!err || typeof err !== 'object') return false;
  const code = (err as Record<string, unknown>).code;
  return code === 'E_USER_CANCELLED' || code === 'E_USER_ERROR';
}
