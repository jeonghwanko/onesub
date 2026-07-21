import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type {
  OneSubConfig,
  SubscriptionInfo,
  PurchaseInfo,
  PurchaseType,
  EntitlementStatus,
} from '@onesub/shared';
import { PURCHASE_TYPE, ONESUB_ERROR_CODE } from '@onesub/shared';
import { checkStatus, validateReceipt, validatePurchase, checkEntitlements } from './api.js';
import {
  handlePurchaseEvent as handlePurchaseEventPure,
  registerInFlight as registerInFlightPure,
  clearInFlight,
  isUserCancelled,
  extractReceiptToken,
  extractTransactionId,
  type InFlightEntry,
} from './purchaseFlow.js';
import { OneSubError } from './OneSubError.js';
import { createSdkLogger } from './logger.js';

// ---------------------------------------------------------------------------
// IAP import — react-native-iap is an optional peer dependency.
// Compatible with react-native-iap v15+ (unified purchaseToken, fetchProducts,
// platform-scoped requestPurchase).
// ---------------------------------------------------------------------------
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let RNIap: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  RNIap = require('react-native-iap');
} catch {
  // react-native-iap not installed — subscribe() will throw a clear error
}

// ---------------------------------------------------------------------------
// Context shape
// ---------------------------------------------------------------------------
export interface OneSubContextValue {
  isActive: boolean;
  isLoading: boolean;
  /** True until the active store mutation, including transaction cleanup, is complete. */
  isBusy: boolean;
  subscription: SubscriptionInfo | null;
  subscribe: () => Promise<void>;
  /**
   * Starts a subscription and returns only when this exact in-flight purchase
   * has passed server validation. Store cleanup may still be running; use
   * `isBusy` to keep every other purchase / restore action disabled.
   * Returns null when the user cancels or another IAP mutation is already busy.
   */
  subscribeWithResult: () => Promise<SubscriptionPurchaseResult | null>;
  restore: () => Promise<void>;
  purchaseProduct: (
    productId: string,
    type: 'consumable' | 'non_consumable',
  ) => Promise<(PurchaseInfo & { action?: 'new' | 'restored' }) | null>;
  /**
   * Restore a one-time purchase (non-consumable) from the store's history.
   * - Queries the native store for existing purchases
   * - If found, sends the receipt to the server for validation
   * - Server inserts into onesub_purchases if not already recorded
   * Returns the recorded PurchaseInfo on success, or null if the store has no
   * record of the product (i.e. the user never purchased).
   */
  restoreProduct: (
    productId: string,
    type: 'consumable' | 'non_consumable',
  ) => Promise<(PurchaseInfo & { action?: 'new' | 'restored' }) | null>;
  /**
   * Map of entitlement id → evaluation status, populated from the server.
   * Empty when the server has no entitlements configured. Auto-refreshed
   * after subscribe / restore / purchase / restoreProduct.
   */
  entitlements: Record<string, EntitlementStatus>;
  /** Convenience: `entitlements[id]?.active === true`. */
  hasEntitlement: (id: string) => boolean;
  /** Manually re-fetch the entitlements map. */
  refreshEntitlements: () => Promise<void>;
}

/** Server-validated result for the subscription request started by the caller. */
export interface SubscriptionPurchaseResult {
  subscription: SubscriptionInfo;
}

interface SubscriptionFlowOutcome extends SubscriptionPurchaseResult {
  /** StoreKit/Play transaction cleanup that continues after validation. */
  cleanup: Promise<void>;
}

const OneSubContext = createContext<OneSubContextValue | null>(null);

/** @internal */
export function useOneSubContext(): OneSubContextValue {
  const ctx = useContext(OneSubContext);
  if (!ctx) {
    throw new OneSubError(ONESUB_ERROR_CODE.NOT_IN_PROVIDER, '[onesub] useOneSub must be used inside <OneSubProvider>');
  }
  return ctx;
}

function getProductId(config: OneSubConfig, platform: 'ios' | 'android'): string {
  if (platform === 'ios') return config.appleProductId ?? config.productId;
  return config.googleProductId ?? config.productId;
}

function getCurrentPlatform(): 'ios' | 'android' {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Platform } = require('react-native') as typeof import('react-native');
  return Platform.OS === 'ios' ? 'ios' : 'android';
}

// ---------------------------------------------------------------------------
// Helper — build platform-scoped requestPurchase args for react-native-iap v15
// ---------------------------------------------------------------------------
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function buildRequestPurchaseArgs(
  sku: string,
  platform: 'ios' | 'android',
  type: 'in-app' | 'subs',
  accountToken?: string,
) {
  // accountToken binds the purchase to a stable account identity: Apple bakes it
  // into the signed transaction as `appAccountToken` (must be a UUID), Android
  // carries it as `obfuscatedAccountId` (the react-native-iap v15 REQUEST field —
  // note the purchase RESULT uses the suffixed `obfuscatedAccountIdAndroid`, do
  // not confuse them). The server's validate route rejects attributing/reassigning
  // the purchase to a different userId, so a leaked receipt cannot be claimed by
  // another account. Optional — omitted when the host doesn't pass `accountToken`.
  //
  // Each store rejects malformed tokens at purchase time (Apple: non-UUID;
  // Google: obfuscatedAccountId > 64 chars → DEVELOPER_ERROR), which would break
  // the purchase sheet itself. Degrade an invalid token to an unbound purchase
  // rather than let it break checkout.
  const iosToken = accountToken && UUID_RE.test(accountToken) ? accountToken : undefined;
  const androidToken = accountToken && accountToken.length <= 64 ? accountToken : undefined;
  if (accountToken && typeof console !== 'undefined') {
    if (platform === 'ios' && !iosToken) {
      console.warn('[onesub] accountToken is not a UUID — omitted on iOS; purchase will be unbound');
    } else if (platform === 'android' && !androidToken) {
      console.warn('[onesub] accountToken exceeds 64 chars — omitted on Android; purchase will be unbound');
    }
  }
  const apple = iosToken ? { sku, appAccountToken: iosToken } : { sku };
  const androidExtra = androidToken ? { obfuscatedAccountId: androidToken } : {};
  const request =
    platform === 'ios'
      ? { ios: apple }
      : type === 'subs'
        ? { android: { skus: [sku], subscriptionOffers: [], ...androidExtra } }
        : { android: { skus: [sku], ...androidExtra } };

  return { request, type };
}

// ---------------------------------------------------------------------------
// Architecture notes — why a single mount-level listener (read before editing)
//
// StoreKit 2 delivers unfinished transactions via `Transaction.updates`, an
// AsyncSequence that Apple documents as firing "each time the system creates
// a transaction OR the app launches with unfinished transactions" (see
// https://developer.apple.com/documentation/storekit/transaction/updates).
//
// react-native-iap v15 (OpenIAP-Apple under the hood) bridges every event
// from Transaction.updates to `purchaseUpdatedListener` indiscriminately.
// It is NOT possible to reliably distinguish a replay of a previously
// unfinished transaction from a freshly created one on the client.
//
// The correct architecture (as used by RevenueCat, Qonversion, Adapty) is:
//
//   1. Attach ONE listener for the lifetime of the Provider.
//   2. Validate every event against the server. The server is idempotent —
//      it returns `action: 'new'` for first-time transactionIds and
//      `action: 'restored'` for redeliveries.
//   3. Call finishTransaction ONLY after the server returns 2xx. If the
//      server is unreachable, leave the transaction unfinished so StoreKit
//      replays it on the next app launch (at-least-once semantics).
//   4. Per-call `subscribe()` / `purchaseProduct()` registers an in-flight
//      promise in a ref map keyed by productId. The listener resolves it
//      when a matching event arrives. Events with no matching in-flight
//      entry are "orphan" replays — processed silently (state updated, but
//      no promise to resolve, no UI side-effect).
//
// Why this fixes the "TestFlight: sheet doesn't appear, app says 결제 복구됨"
// bug: under the old per-call listener pattern, attaching the listener after
// initConnection immediately delivered the pending transaction (before
// requestPurchase could show the StoreKit sheet). The listener resolved the
// promise with that stale event. Under this mount-level pattern, pending
// transactions are drained silently right after initConnection, so by the
// time the user taps Subscribe the queue is empty and the only event that
// can fire is the fresh transaction StoreKit creates after the user confirms
// in the sheet.
// ---------------------------------------------------------------------------

export interface OneSubProviderProps {
  config: OneSubConfig;
  userId: string;
  /**
   * Stable account identity baked into each purchase (Apple `appAccountToken`,
   * Android `obfuscatedAccountId`). Bind this to an identity that survives
   * reinstall (e.g. a UUID derived from a hardware id hash) and is the SAME value
   * you pass as `userId`, so the server's validate route accepts the purchase.
   * Apple requires a UUID string. Omit to keep the previous unbound behavior.
   */
  accountToken?: string;
  children: React.ReactNode;
}

export function OneSubProvider({ config, userId, accountToken, children }: OneSubProviderProps) {
  const [isActive, setIsActive] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isBusy, setIsBusy] = useState(false);
  const [subscription, setSubscription] = useState<SubscriptionInfo | null>(null);
  const [entitlements, setEntitlements] = useState<Record<string, EntitlementStatus>>({});

  const isBusyRef = useRef(false);
  const releaseIapOperation = useCallback(() => {
    isBusyRef.current = false;
    setIsBusy(false);
    setIsLoading(false);
  }, []);
  // Read via ref so the stable purchase callbacks always see the latest token
  // (it may resolve asynchronously on the host, e.g. after hashing a hardware id)
  // without needing to be in their dependency arrays.
  const accountTokenRef = useRef(accountToken);
  accountTokenRef.current = accountToken;
  const inFlightRef = useRef<Map<string, InFlightEntry>>(new Map());
  // Recreate only when the relevant config fields change — referential
  // stability keeps re-mount effects from firing on every parent render.
  const logger = useMemo(
    () => createSdkLogger({ debug: config.debug, logger: config.logger }),
    [config.debug, config.logger],
  );
  // Drain window: during the first ~2.5s after mount, StoreKit may still be
  // flushing queued `Transaction.updates` redeliveries. Any listener event
  // during this window is treated as an orphan replay regardless of whether
  // a user-initiated in-flight entry exists — otherwise the race "user taps
  // Subscribe → replay arrives → matched as their fresh purchase" reintroduces
  // the silent-restore bug. subscribe()/purchaseProduct() await this flag
  // before registering their in-flight slot.
  const drainCompleteRef = useRef(false);
  // Waiters receive `aborted`: false = drain finished normally (proceed to
  // requestPurchase), true = provider teardown (the parked caller must abort
  // — see awaitDrainComplete, which maps it to a PROVIDER_UNMOUNTED throw).
  const drainWaitersRef = useRef<Array<(aborted: boolean) => void>>([]);
  const DRAIN_WINDOW_MS = 2500;
  const mockMode = config.mockMode === true;

  // One-shot warning per provider mount so it's obvious in logs. The hook must
  // run unconditionally (Rules of Hooks) — the mockMode check lives inside.
  useEffect(() => {
    if (mockMode && typeof console !== 'undefined') {
      console.warn(
        '[onesub] mockMode is enabled — all purchases/restores return synthetic ' +
          'success without calling the store or server. Disable before production.',
      );
    }
  }, [mockMode]);

  function mockPurchaseInfo(productId: string, type: 'consumable' | 'non_consumable'): PurchaseInfo {
    return {
      transactionId: `mock_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
      userId,
      productId,
      platform: 'apple',
      type: type === 'consumable' ? PURCHASE_TYPE.CONSUMABLE : PURCHASE_TYPE.NON_CONSUMABLE,
      quantity: 1,
      purchasedAt: new Date().toISOString(),
    } as PurchaseInfo;
  }

  // -------------------------------------------------------------------------
  // Mount: load initial status, open IAP connection, attach listeners.
  // -------------------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let updatedSub: any = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let errorSub: any = null;

    // Re-runs of this effect (userId/serverUrl change) re-init the IAP
    // connection, which can replay queued transactions all over again — the
    // drain gate must be re-armed BEFORE setupIap so those replays can't
    // match a fresh in-flight entry.
    drainCompleteRef.current = false;

    async function loadStatus() {
      setIsLoading(true);
      try {
        const status = await checkStatus(config.serverUrl, userId);
        if (!cancelled) {
          setIsActive(status.active);
          setSubscription(status.subscription);
        }
      } catch {
        if (!cancelled) {
          setIsActive(false);
          setSubscription(null);
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    async function loadEntitlements() {
      try {
        const result = await checkEntitlements(config.serverUrl, userId);
        if (!cancelled) setEntitlements(result.entitlements);
      } catch {
        // Network/server failure — leave existing entitlements untouched. The
        // map will be retried on next refresh trigger (post-purchase /
        // explicit refreshEntitlements call).
      }
    }

    function releaseDrain(reason: string) {
      drainCompleteRef.current = true;
      const waiters = drainWaitersRef.current.length;
      drainWaitersRef.current.forEach((w) => w(false));
      drainWaitersRef.current = [];
      logger.trace('drain released', { reason, waiters });
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async function handlePurchaseEvent(purchase: any): Promise<void> {
      const platform = getCurrentPlatform();
      await handlePurchaseEventPure(purchase, {
        config,
        userId,
        platform,
        inFlight: inFlightRef.current,
        RNIap,
        api: { validateReceipt, validatePurchase },
        onSubscriptionActivated: (sub) => {
          setIsActive(true);
          setSubscription(sub);
        },
        isCancelled: () => cancelled,
        allowInFlightMatching: () => drainCompleteRef.current,
        logger,
      });
    }

    async function setupIap(): Promise<void> {
      if (!RNIap || mockMode) {
        releaseDrain(mockMode ? 'mockMode' : 'no-rn-iap');
        return;
      }
      try {
        logger.trace('initConnection start');
        await RNIap.initConnection();
        logger.trace('initConnection ok');
      } catch (err) {
        logger.warn('initConnection failed', err);
        releaseDrain('init-failed');
        return;
      }
      if (cancelled) return;

      // Attach listeners BEFORE any further await so we catch every replay
      // from Transaction.updates.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      updatedSub = RNIap.purchaseUpdatedListener((purchase: any) => {
        void handlePurchaseEvent(purchase);
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      errorSub = RNIap.purchaseErrorListener((err: any) => {
        // Errors are routed to every in-flight promise (we can't tell which
        // SKU StoreKit was processing when an error fires). RN-IAP surfaces
        // 'E_USER_CANCELLED' / 'E_USER_ERROR' — map both to USER_CANCELLED.
        const rnCode: string | undefined = typeof err?.code === 'string' ? err.code : undefined;
        const code = (rnCode === 'E_USER_CANCELLED' || rnCode === 'E_USER_ERROR')
          ? ONESUB_ERROR_CODE.USER_CANCELLED
          : ONESUB_ERROR_CODE.INTERNAL_ERROR;
        logger.trace('purchase error event', { code, rnCode, inFlightCount: inFlightRef.current.size });
        const wrapped = new OneSubError(code, err?.message ?? '[onesub] Purchase error', err);
        for (const [pid, entry] of inFlightRef.current.entries()) {
          entry.reject(wrapped);
          inFlightRef.current.delete(pid);
        }
      });
      logger.trace('listeners attached; drain window open', { drainMs: DRAIN_WINDOW_MS });

      // Release the drain gate after the window closes. Any queued replays
      // have been processed silently by now; in-flight matching becomes
      // active so user-initiated subscribe()/purchaseProduct() can resolve.
      setTimeout(() => {
        if (cancelled) return;
        releaseDrain('timeout');
      }, DRAIN_WINDOW_MS);
    }

    logger.trace('provider mount', { serverUrl: config.serverUrl, userId, mockMode });
    void loadStatus();
    void loadEntitlements();
    void setupIap();

    return () => {
      cancelled = true;
      logger.trace('provider unmount', { pendingInFlight: inFlightRef.current.size });
      try { updatedSub?.remove?.(); } catch { /* ignore */ }
      try { errorSub?.remove?.(); } catch { /* ignore */ }
      // Reject any dangling in-flight promises so callers don't hang forever
      for (const [pid, entry] of inFlightRef.current.entries()) {
        entry.reject(new OneSubError(ONESUB_ERROR_CODE.PROVIDER_UNMOUNTED, '[onesub] Provider unmounted'));
        inFlightRef.current.delete(pid);
      }
      // Wake anyone parked in awaitDrainComplete so they don't hang forever
      // after unmount — with aborted=true, so they throw PROVIDER_UNMOUNTED
      // (same code as the in-flight rejections above) instead of proceeding
      // to requestPurchase on a dead session. On a re-mount the effect body
      // re-arms the gate above before setupIap runs.
      const waiters = drainWaitersRef.current;
      drainWaitersRef.current = [];
      waiters.forEach((w) => w(true));
      if (RNIap) {
        void RNIap.endConnection?.().catch?.(() => {
          /* ignore */
        });
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.serverUrl, userId]);

  // Block purchase/subscribe until the mount drain window closes. Returns
  // immediately if already complete, otherwise queues the caller. If the
  // provider tears down while the caller is parked, rejects with
  // PROVIDER_UNMOUNTED — the same error the cleanup uses for in-flight
  // entries — so the caller aborts instead of calling requestPurchase after
  // listeners are removed and the connection is closed.
  function awaitDrainComplete(): Promise<void> {
    if (drainCompleteRef.current) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      drainWaitersRef.current.push((aborted) => {
        if (aborted) {
          reject(new OneSubError(ONESUB_ERROR_CODE.PROVIDER_UNMOUNTED, '[onesub] Provider unmounted'));
        } else {
          resolve();
        }
      });
    });
  }

  function registerInFlight<T>(
    productId: string,
    kind: 'subscription' | 'purchase',
    purchaseType: 'consumable' | 'non_consumable' | undefined,
  ): Promise<T> {
    return registerInFlightPure<T>(inFlightRef.current, productId, kind, purchaseType);
  }

  // -------------------------------------------------------------------------
  // Subscription purchase core. The matched validation result and native
  // transaction cleanup deliberately have separate completion points.
  // -------------------------------------------------------------------------
  const startSubscriptionFlow = useCallback(async (): Promise<SubscriptionFlowOutcome | null> => {
    if (isBusyRef.current) return null;
    if (mockMode) {
      const mockSubscription = {
        userId,
        productId: getProductId(config, 'ios'),
      } as SubscriptionInfo;
      setIsActive(true);
      setSubscription(mockSubscription);
      return { subscription: mockSubscription, cleanup: Promise.resolve() };
    }
    if (!RNIap) {
      throw new OneSubError(
        ONESUB_ERROR_CODE.RN_IAP_NOT_INSTALLED,
        '[onesub] react-native-iap is not installed. Add it as a dependency: npm install react-native-iap',
      );
    }

    isBusyRef.current = true;
    setIsBusy(true);
    setIsLoading(true);
    let cleanupHandedOff = false;
    const startedAt = Date.now();

    try {
      const platform = getCurrentPlatform();
      const productId = getProductId(config, platform);
      logger.trace('subscribe() called', { productId, drainReady: drainCompleteRef.current });

      // Wait until the mount drain window closes. During drain StoreKit may
      // still be flushing queued replays, and in-flight matching is disabled.
      const drainStartedAt = Date.now();
      await awaitDrainComplete();
      logger.trace('subscribe drain complete', {
        durationMs: Date.now() - drainStartedAt,
        totalMs: Date.now() - startedAt,
      });

      // v15: fetchProducts replaces getSubscriptions
      const fetchStartedAt = Date.now();
      const subs = await RNIap.fetchProducts({ skus: [productId], type: 'subs' });
      logger.trace('subscription products fetched', {
        durationMs: Date.now() - fetchStartedAt,
        totalMs: Date.now() - startedAt,
      });
      if (!subs || !subs.length) {
        throw new OneSubError(ONESUB_ERROR_CODE.PRODUCT_NOT_FOUND, `[onesub] Subscription product not found: ${productId}`);
      }

      // Register in-flight promise BEFORE calling requestPurchase — the
      // mount-level listener matches incoming events to this entry.
      const resultPromise = registerInFlight<{
        valid: boolean;
        subscription?: SubscriptionInfo;
        error?: string;
        cleanup?: Promise<void>;
      }>(
        productId,
        'subscription',
        undefined,
      );
      // The error listener may reject this promise while we're still awaiting
      // requestPurchase below — attach a no-op handler so that rejection is
      // never "unhandled". The original promise is still awaited afterwards.
      void resultPromise.catch(() => {});
      try {
        const requestStartedAt = Date.now();
        await RNIap.requestPurchase(buildRequestPurchaseArgs(productId, platform, 'subs', accountTokenRef.current));
        logger.trace('subscription store request returned', {
          durationMs: Date.now() - requestStartedAt,
          totalMs: Date.now() - startedAt,
        });
      } catch (err) {
        clearInFlight(inFlightRef.current, productId);
        if (isUserCancelled(err)) return null;
        throw err;
      }
      const validationStartedAt = Date.now();
      const result = await resultPromise;
      logger.trace('subscription in-flight validated', {
        durationMs: Date.now() - validationStartedAt,
        totalMs: Date.now() - startedAt,
      });
      if (!result.valid || !result.subscription) {
        throw new OneSubError(ONESUB_ERROR_CODE.RECEIPT_VALIDATION_FAILED, result.error ?? '[onesub] Subscription validation failed.');
      }
      const cleanup = result.cleanup ?? Promise.resolve();
      cleanupHandedOff = true;
      return { subscription: result.subscription, cleanup };
    } catch (err) {
      // A cancel surfaced via the error listener rejects the in-flight promise
      // with USER_CANCELLED — treat it like a cancel from requestPurchase and
      // return normally (same contract as purchaseProduct).
      if (isUserCancelled(err)) return null;
      throw err;
    } finally {
      // On validation success the public fast path owns cleanup and releases
      // the busy lock only after finishTransaction settles.
      if (!cleanupHandedOff) releaseIapOperation();
    }
  }, [config, userId, mockMode, releaseIapOperation]);

  // -------------------------------------------------------------------------
  // restore() — query the store's existing purchases and re-validate with server.
  // -------------------------------------------------------------------------
  const restore = useCallback(async () => {
    if (isBusyRef.current) return;
    if (mockMode) {
      setIsActive(true);
      return;
    }
    if (!RNIap) {
      throw new OneSubError(
        ONESUB_ERROR_CODE.RN_IAP_NOT_INSTALLED,
        '[onesub] react-native-iap is not installed. Add it as a dependency: npm install react-native-iap',
      );
    }

    isBusyRef.current = true;
    setIsBusy(true);
    setIsLoading(true);

    try {
      const platform = getCurrentPlatform();
      const purchases = await RNIap.getAvailablePurchases();

      const productId = getProductId(config, platform);
      const match = purchases.find((p: { productId: string }) => p.productId === productId);

      if (!match) {
        const status = await checkStatus(config.serverUrl, userId);
        setIsActive(status.active);
        setSubscription(status.subscription);
        return;
      }

      const receiptToken = extractReceiptToken(match);
      if (!receiptToken) {
        // Same guard as restoreProduct — posting an empty receipt would only
        // earn a 400 from the server.
        throw new OneSubError(ONESUB_ERROR_CODE.NO_RECEIPT_DATA, '[onesub] Matched purchase has no receipt data.');
      }

      const result = await validateReceipt(config.serverUrl, {
        platform: platform === 'ios' ? 'apple' : 'google',
        receipt: receiptToken,
        userId,
        productId,
        ...(config.appId ? { appId: config.appId } : {}),
      });

      if (result.valid && result.subscription) {
        setIsActive(true);
        setSubscription(result.subscription);
      } else {
        const status = await checkStatus(config.serverUrl, userId);
        setIsActive(status.active);
        setSubscription(status.subscription);
      }
    } finally {
      releaseIapOperation();
    }
  }, [config, userId, mockMode, releaseIapOperation]);

  // -------------------------------------------------------------------------
  // purchaseProduct() — consumable or non-consumable one-time purchase
  // -------------------------------------------------------------------------
  const purchaseProduct = useCallback(
    async (
      productId: string,
      type: 'consumable' | 'non_consumable',
    ): Promise<(PurchaseInfo & { action?: 'new' | 'restored' }) | null> => {
      if (isBusyRef.current) return null;
      if (mockMode) {
        return mockPurchaseInfo(productId, type);
      }
      if (!RNIap) {
        throw new OneSubError(
          ONESUB_ERROR_CODE.RN_IAP_NOT_INSTALLED,
          '[onesub] react-native-iap is not installed. Add it as a dependency: npm install react-native-iap',
        );
      }

      isBusyRef.current = true;
      setIsBusy(true);
      setIsLoading(true);

      try {
        const platform = getCurrentPlatform();
        logger.trace('purchaseProduct() called', { productId, type, drainReady: drainCompleteRef.current });

        // Same drain-window gate as subscribe() — see there for rationale.
        await awaitDrainComplete();

        const products = await RNIap.fetchProducts({ skus: [productId], type: 'in-app' });
        if (!products || !products.length) {
          throw new OneSubError(ONESUB_ERROR_CODE.PRODUCT_NOT_FOUND, `[onesub] Product not found in store: ${productId}`);
        }

        const resultPromise = registerInFlight<{
          valid: boolean;
          purchase?: PurchaseInfo;
          action?: 'new' | 'restored';
          error?: string;
        }>(productId, 'purchase', type);
        // See subscribe() — guard against an unhandled rejection while
        // requestPurchase is still pending. The promise is awaited below.
        void resultPromise.catch(() => {});

        try {
          await RNIap.requestPurchase(buildRequestPurchaseArgs(productId, platform, 'in-app', accountTokenRef.current));
        } catch (err) {
          clearInFlight(inFlightRef.current, productId);
          if (isUserCancelled(err)) return null;
          throw err;
        }

        const result = await resultPromise;
        if (result.valid && result.purchase) {
          return { ...result.purchase, action: result.action };
        }
        throw new OneSubError(ONESUB_ERROR_CODE.RECEIPT_VALIDATION_FAILED, result.error ?? '[onesub] Purchase validation failed.');
      } catch (err) {
        if (isUserCancelled(err)) return null;
        throw err;
      } finally {
        releaseIapOperation();
      }
    },
    [config, userId, mockMode, releaseIapOperation],
  );

  // -------------------------------------------------------------------------
  // restoreProduct() — restore a one-time purchase (non-consumable)
  // -------------------------------------------------------------------------
  const restoreProduct = useCallback(
    async (
      productId: string,
      type: 'consumable' | 'non_consumable',
    ): Promise<(PurchaseInfo & { action?: 'new' | 'restored' }) | null> => {
      if (isBusyRef.current) return null;
      if (mockMode) {
        return mockPurchaseInfo(productId, type);
      }
      if (!RNIap) {
        throw new OneSubError(
          ONESUB_ERROR_CODE.RN_IAP_NOT_INSTALLED,
          '[onesub] react-native-iap is not installed. Add it as a dependency: npm install react-native-iap',
        );
      }

      isBusyRef.current = true;
      setIsBusy(true);
      setIsLoading(true);

      try {
        const platform = getCurrentPlatform();

        const purchases = await RNIap.getAvailablePurchases();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const match = (purchases as any[]).find((p) => p?.productId === productId);
        if (!match) {
          return null; // user never purchased this product in the store
        }

        const receipt = extractReceiptToken(match);
        if (!receipt) {
          throw new OneSubError(ONESUB_ERROR_CODE.NO_RECEIPT_DATA, '[onesub] Matched purchase has no receipt data.');
        }

        const purchaseType: PurchaseType =
          type === 'consumable' ? PURCHASE_TYPE.CONSUMABLE : PURCHASE_TYPE.NON_CONSUMABLE;

        const validationResult = await validatePurchase(config.serverUrl, {
          platform: platform === 'ios' ? 'apple' : 'google',
          receipt,
          userId,
          productId,
          type: purchaseType,
          ...(config.appId ? { appId: config.appId } : {}),
        });

        if (validationResult.valid && validationResult.purchase) {
          return { ...validationResult.purchase, action: validationResult.action } as PurchaseInfo & { action?: 'new' | 'restored' };
        }

        // Non-consumable already owned on the server side is still a success
        // from the user's perspective — they do own it. Surface it as such,
        // carrying the store transactionId so receipt-forwarding hosts can
        // re-entitle. (Defensive: updated servers return the recorded purchase
        // via the valid:true branch above; this covers legacy 409 servers.)
        if (validationResult.error === 'NON_CONSUMABLE_ALREADY_OWNED') {
          return {
            productId,
            userId,
            platform: platform === 'ios' ? 'apple' : 'google',
            type: purchaseType,
            transactionId: extractTransactionId(match),
            purchasedAt: new Date().toISOString(),
            quantity: 1,
            action: 'restored',
          } satisfies PurchaseInfo & { action: 'restored' };
        }

        throw new OneSubError(ONESUB_ERROR_CODE.RECEIPT_VALIDATION_FAILED, validationResult.error ?? '[onesub] Restore validation failed.');
      } finally {
        releaseIapOperation();
      }
    },
    [config, userId, mockMode, releaseIapOperation],
  );

  // Stable refresh function exposed via context. Re-fetches the entitlements
  // map without touching subscription state. Called automatically after
  // subscribe/restore/purchase/restoreProduct via the wrappers below; hosts can
  // also call it directly when they know server-side state changed (e.g. after
  // an admin grant).
  const refreshEntitlements = useCallback(async () => {
    try {
      const result = await checkEntitlements(config.serverUrl, userId);
      setEntitlements(result.entitlements);
    } catch {
      // Leave previous map in place on transient failure.
    }
  }, [config.serverUrl, userId]);

  const hasEntitlement = useCallback(
    (id: string) => entitlements[id]?.active === true,
    [entitlements],
  );

  // Wrap the four mutation methods so a successful run automatically triggers
  // an entitlements refresh — the host doesn't have to remember to refresh
  // after each purchase/restore. Failures don't trigger a refresh (status
  // unchanged).
  const settleSubscriptionCleanup = useCallback(async (outcome: SubscriptionFlowOutcome) => {
    try {
      await outcome.cleanup;
    } finally {
      releaseIapOperation();
    }
  }, [releaseIapOperation]);

  // Backward-compatible API: preserve the historical contract that subscribe()
  // waits for native transaction cleanup before resolving.
  const subscribeWithRefresh = useCallback(async () => {
    const outcome = await startSubscriptionFlow();
    if (!outcome) return;
    await settleSubscriptionCleanup(outcome);
    void refreshEntitlements();
  }, [startSubscriptionFlow, settleSubscriptionCleanup, refreshEntitlements]);

  // Fast, transaction-correlated API: validation completes the caller while
  // cleanup continues under the SDK-wide busy lock.
  const subscribeWithResultAndRefresh = useCallback(async (): Promise<SubscriptionPurchaseResult | null> => {
    const outcome = await startSubscriptionFlow();
    if (!outcome) return null;
    void settleSubscriptionCleanup(outcome).catch(() => {
      // purchaseFlow already converts finish failures into a recoverable replay.
    });
    void refreshEntitlements();
    return { subscription: outcome.subscription };
  }, [startSubscriptionFlow, settleSubscriptionCleanup, refreshEntitlements]);

  const restoreWithRefresh = useCallback(async () => {
    await restore();
    void refreshEntitlements();
  }, [restore, refreshEntitlements]);

  const purchaseProductWithRefresh = useCallback(
    async (productId: string, type: 'consumable' | 'non_consumable') => {
      const result = await purchaseProduct(productId, type);
      if (result) void refreshEntitlements();
      return result;
    },
    [purchaseProduct, refreshEntitlements],
  );

  const restoreProductWithRefresh = useCallback(
    async (productId: string, type: 'consumable' | 'non_consumable') => {
      const result = await restoreProduct(productId, type);
      if (result) void refreshEntitlements();
      return result;
    },
    [restoreProduct, refreshEntitlements],
  );

  const value: OneSubContextValue = {
    isActive,
    isLoading,
    isBusy,
    subscription,
    subscribe: subscribeWithRefresh,
    subscribeWithResult: subscribeWithResultAndRefresh,
    restore: restoreWithRefresh,
    purchaseProduct: purchaseProductWithRefresh,
    restoreProduct: restoreProductWithRefresh,
    entitlements,
    hasEntitlement,
    refreshEntitlements,
  };

  return <OneSubContext.Provider value={value}>{children}</OneSubContext.Provider>;
}
