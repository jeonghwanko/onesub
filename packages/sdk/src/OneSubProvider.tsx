import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import type { OneSubConfig, SubscriptionInfo, PurchaseInfo, PurchaseType } from '@onesub/shared';
import { PURCHASE_TYPE } from '@onesub/shared';
import { checkStatus, validateReceipt, validatePurchase } from './api.js';
import {
  handlePurchaseEvent as handlePurchaseEventPure,
  registerInFlight as registerInFlightPure,
  extractReceiptToken,
  type InFlightEntry,
} from './purchaseFlow.js';

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
  subscription: SubscriptionInfo | null;
  subscribe: () => Promise<void>;
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
}

const OneSubContext = createContext<OneSubContextValue | null>(null);

/** @internal */
export function useOneSubContext(): OneSubContextValue {
  const ctx = useContext(OneSubContext);
  if (!ctx) {
    throw new Error('[onesub] useOneSub must be used inside <OneSubProvider>');
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

function isUserCancelled(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as Record<string, unknown>).code;
  return code === 'E_USER_CANCELLED' || code === 'E_USER_ERROR';
}

// ---------------------------------------------------------------------------
// Helper — build platform-scoped requestPurchase args for react-native-iap v15
// ---------------------------------------------------------------------------
function buildRequestPurchaseArgs(
  sku: string,
  platform: 'ios' | 'android',
  type: 'in-app' | 'subs',
) {
  const request =
    platform === 'ios'
      ? { ios: { sku } }
      : type === 'subs'
        ? { android: { skus: [sku], subscriptionOffers: [] } }
        : { android: { skus: [sku] } };

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
  children: React.ReactNode;
}

export function OneSubProvider({ config, userId, children }: OneSubProviderProps) {
  const [isActive, setIsActive] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [subscription, setSubscription] = useState<SubscriptionInfo | null>(null);

  const isBusyRef = useRef(false);
  const inFlightRef = useRef<Map<string, InFlightEntry>>(new Map());
  // Drain window: during the first ~2.5s after mount, StoreKit may still be
  // flushing queued `Transaction.updates` redeliveries. Any listener event
  // during this window is treated as an orphan replay regardless of whether
  // a user-initiated in-flight entry exists — otherwise the race "user taps
  // Subscribe → replay arrives → matched as their fresh purchase" reintroduces
  // the silent-restore bug. subscribe()/purchaseProduct() await this flag
  // before registering their in-flight slot.
  const drainCompleteRef = useRef(false);
  const drainWaitersRef = useRef<Array<() => void>>([]);
  const DRAIN_WINDOW_MS = 2500;
  const mockMode = config.mockMode === true;

  if (mockMode && typeof console !== 'undefined') {
    // One-shot warning per provider mount so it's obvious in logs.
    // eslint-disable-next-line react-hooks/rules-of-hooks
    useEffect(() => {
      console.warn(
        '[onesub] mockMode is enabled — all purchases/restores return synthetic ' +
          'success without calling the store or server. Disable before production.',
      );
    }, []);
  }

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
      });
    }

    async function setupIap(): Promise<void> {
      if (!RNIap || mockMode) {
        // No IAP to drain — release the purchase gate immediately.
        drainCompleteRef.current = true;
        drainWaitersRef.current.forEach((w) => w());
        drainWaitersRef.current = [];
        return;
      }
      try {
        await RNIap.initConnection();
      } catch {
        drainCompleteRef.current = true;
        drainWaitersRef.current.forEach((w) => w());
        drainWaitersRef.current = [];
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
        // SKU StoreKit was processing when an error fires).
        const wrapped: Error & { code?: string } = new Error(
          err?.message ?? '[onesub] Purchase error',
        );
        if (err?.code) wrapped.code = err.code;
        for (const [pid, entry] of inFlightRef.current.entries()) {
          entry.reject(wrapped);
          inFlightRef.current.delete(pid);
        }
      });

      // Release the drain gate after the window closes. Any queued replays
      // have been processed silently by now; in-flight matching becomes
      // active so user-initiated subscribe()/purchaseProduct() can resolve.
      setTimeout(() => {
        if (cancelled) return;
        drainCompleteRef.current = true;
        drainWaitersRef.current.forEach((w) => w());
        drainWaitersRef.current = [];
      }, DRAIN_WINDOW_MS);
    }

    void loadStatus();
    void setupIap();

    return () => {
      cancelled = true;
      try { updatedSub?.remove?.(); } catch { /* ignore */ }
      try { errorSub?.remove?.(); } catch { /* ignore */ }
      // Reject any dangling in-flight promises so callers don't hang forever
      for (const [pid, entry] of inFlightRef.current.entries()) {
        entry.reject(new Error('[onesub] Provider unmounted'));
        inFlightRef.current.delete(pid);
      }
      if (RNIap) {
        void RNIap.endConnection?.().catch?.(() => {
          /* ignore */
        });
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.serverUrl, userId]);

  // Block purchase/subscribe until the mount drain window closes. Returns
  // immediately if already complete, otherwise queues the caller.
  function awaitDrainComplete(): Promise<void> {
    if (drainCompleteRef.current) return Promise.resolve();
    return new Promise<void>((resolve) => {
      drainWaitersRef.current.push(resolve);
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
  // subscribe()
  // -------------------------------------------------------------------------
  const subscribe = useCallback(async () => {
    if (isBusyRef.current) return;
    if (mockMode) {
      setIsActive(true);
      setSubscription({ userId, productId: getProductId(config, 'ios') } as SubscriptionInfo);
      return;
    }
    if (!RNIap) {
      throw new Error(
        '[onesub] react-native-iap is not installed. Add it as a dependency: npm install react-native-iap',
      );
    }

    isBusyRef.current = true;
    setIsLoading(true);

    try {
      const platform = getCurrentPlatform();
      const productId = getProductId(config, platform);

      // Wait until the mount drain window closes. During drain StoreKit may
      // still be flushing queued replays, and in-flight matching is disabled.
      await awaitDrainComplete();

      // v15: fetchProducts replaces getSubscriptions
      const subs = await RNIap.fetchProducts({ skus: [productId], type: 'subs' });
      if (!subs || !subs.length) {
        throw new Error(`[onesub] Subscription product not found: ${productId}`);
      }

      // Register in-flight promise BEFORE calling requestPurchase — the
      // mount-level listener matches incoming events to this entry.
      const resultPromise = registerInFlight<{ valid: boolean; subscription?: SubscriptionInfo; error?: string }>(
        productId,
        'subscription',
        undefined,
      );
      try {
        await RNIap.requestPurchase(buildRequestPurchaseArgs(productId, platform, 'subs'));
      } catch (err) {
        inFlightRef.current.delete(productId);
        if (isUserCancelled(err)) return;
        throw err;
      }
      const result = await resultPromise;
      if (!result.valid) {
        throw new Error(result.error ?? '[onesub] Subscription validation failed.');
      }
    } finally {
      setIsLoading(false);
      isBusyRef.current = false;
    }
  }, [config, userId, mockMode]);

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
      throw new Error(
        '[onesub] react-native-iap is not installed. Add it as a dependency: npm install react-native-iap',
      );
    }

    isBusyRef.current = true;
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

      const result = await validateReceipt(config.serverUrl, {
        platform: platform === 'ios' ? 'apple' : 'google',
        receipt: receiptToken,
        userId,
        productId,
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
      setIsLoading(false);
      isBusyRef.current = false;
    }
  }, [config, userId, mockMode]);

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
        throw new Error(
          '[onesub] react-native-iap is not installed. Add it as a dependency: npm install react-native-iap',
        );
      }

      isBusyRef.current = true;
      setIsLoading(true);

      try {
        const platform = getCurrentPlatform();

        // Same drain-window gate as subscribe() — see there for rationale.
        await awaitDrainComplete();

        const products = await RNIap.fetchProducts({ skus: [productId], type: 'in-app' });
        if (!products || !products.length) {
          throw new Error(`[onesub] Product not found in store: ${productId}`);
        }

        const resultPromise = registerInFlight<{
          valid: boolean;
          purchase?: PurchaseInfo;
          action?: 'new' | 'restored';
          error?: string;
        }>(productId, 'purchase', type);

        try {
          await RNIap.requestPurchase(buildRequestPurchaseArgs(productId, platform, 'in-app'));
        } catch (err) {
          inFlightRef.current.delete(productId);
          if (isUserCancelled(err)) return null;
          throw err;
        }

        const result = await resultPromise;
        if (result.valid && result.purchase) {
          return { ...result.purchase, action: result.action };
        }
        throw new Error(result.error ?? '[onesub] Purchase validation failed.');
      } catch (err) {
        if (isUserCancelled(err)) return null;
        throw err;
      } finally {
        setIsLoading(false);
        isBusyRef.current = false;
      }
    },
    [config, userId, mockMode],
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
        throw new Error(
          '[onesub] react-native-iap is not installed. Add it as a dependency: npm install react-native-iap',
        );
      }

      isBusyRef.current = true;
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
          throw new Error('[onesub] Matched purchase has no receipt data.');
        }

        const purchaseType: PurchaseType =
          type === 'consumable' ? PURCHASE_TYPE.CONSUMABLE : PURCHASE_TYPE.NON_CONSUMABLE;

        const validationResult = await validatePurchase(config.serverUrl, {
          platform: platform === 'ios' ? 'apple' : 'google',
          receipt,
          userId,
          productId,
          type: purchaseType,
        });

        if (validationResult.valid && validationResult.purchase) {
          return { ...validationResult.purchase, action: validationResult.action } as PurchaseInfo & { action?: 'new' | 'restored' };
        }

        // Non-consumable already owned on the server side is still a success
        // from the user's perspective — they do own it. Surface it as such.
        if (validationResult.error === 'NON_CONSUMABLE_ALREADY_OWNED') {
          return { productId, userId, platform: platform === 'ios' ? 'apple' : 'google', type: purchaseType } as PurchaseInfo;
        }

        throw new Error(validationResult.error ?? '[onesub] Restore validation failed.');
      } finally {
        setIsLoading(false);
        isBusyRef.current = false;
      }
    },
    [config, userId, mockMode],
  );

  const value: OneSubContextValue = {
    isActive,
    isLoading,
    subscription,
    subscribe,
    restore,
    purchaseProduct,
    restoreProduct,
  };

  return <OneSubContext.Provider value={value}>{children}</OneSubContext.Provider>;
}
