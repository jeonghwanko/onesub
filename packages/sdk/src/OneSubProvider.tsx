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
// Helper — await a purchase event for a given productId.
// v15 requestPurchase uses an event-based model: the purchase arrives via
// purchaseUpdatedListener, not as the return value. We wrap the listeners in
// a Promise that resolves on the matching event (or rejects on error/cancel).
// ---------------------------------------------------------------------------
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function awaitPurchaseEvent(productId: string, timeoutMs = 120_000): Promise<any> {
  if (!RNIap) {
    return Promise.reject(new Error('[onesub] react-native-iap not available'));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let updatedSub: any = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let errorSub: any = null;

    const cleanup = () => {
      try { updatedSub?.remove?.(); } catch { /* ignore */ }
      try { errorSub?.remove?.(); } catch { /* ignore */ }
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('[onesub] Purchase timed out'));
    }, timeoutMs);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    updatedSub = RNIap.purchaseUpdatedListener((purchase: any) => {
      if (settled) return;
      if (!purchase) return;
      if (purchase.productId && purchase.productId !== productId) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      resolve(purchase);
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    errorSub = RNIap.purchaseErrorListener((err: any) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      const wrapped: Error & { code?: string } = new Error(
        err?.message ?? '[onesub] Purchase error',
      );
      if (err?.code) wrapped.code = err.code;
      reject(wrapped);
    });
  });
}

// ---------------------------------------------------------------------------
// Helper — extract the unified purchase token from a v15 Purchase object
// ---------------------------------------------------------------------------
function extractReceiptToken(purchase: unknown): string {
  if (!purchase || typeof purchase !== 'object') return '';
  const p = purchase as Record<string, unknown>;
  // v15: unified `purchaseToken` (iOS JWS or Android purchaseToken)
  if (typeof p.purchaseToken === 'string' && p.purchaseToken.length > 0) {
    return p.purchaseToken;
  }
  // Legacy fallback (v12 and earlier)
  if (typeof p.transactionReceipt === 'string' && p.transactionReceipt.length > 0) {
    return p.transactionReceipt;
  }
  return '';
}

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

  useEffect(() => {
    let cancelled = false;

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

    void loadStatus();
    return () => {
      cancelled = true;
      if (RNIap) {
        void RNIap.endConnection().catch(() => {
          /* ignore */
        });
      }
    };
  }, [config.serverUrl, userId]);

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

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let singlePurchase: any = null;

    try {
      const platform = getCurrentPlatform();
      const productId = getProductId(config, platform);

      await RNIap.initConnection();

      // v15: fetchProducts replaces getSubscriptions
      const subs = await RNIap.fetchProducts({ skus: [productId], type: 'subs' });
      if (!subs || !subs.length) {
        throw new Error(`[onesub] Subscription product not found: ${productId}`);
      }

      // v15: event-based purchase — listen before kicking off the request
      const eventPromise = awaitPurchaseEvent(productId);
      await RNIap.requestPurchase(buildRequestPurchaseArgs(productId, platform, 'subs'));
      singlePurchase = await eventPromise;
      if (!singlePurchase) {
        throw new Error('[onesub] No purchase data returned from the store.');
      }

      const receiptToken = extractReceiptToken(singlePurchase);
      if (!receiptToken) {
        throw new Error('[onesub] No receipt data in purchase response.');
      }

      const validationResult = await validateReceipt(config.serverUrl, {
        platform: platform === 'ios' ? 'apple' : 'google',
        receipt: receiptToken,
        userId,
        productId,
      });

      if (validationResult.valid && validationResult.subscription) {
        setIsActive(true);
        setSubscription(validationResult.subscription);
      } else {
        throw new Error(validationResult.error ?? '[onesub] Receipt validation failed.');
      }
    } finally {
      if (singlePurchase) {
        await RNIap.finishTransaction({ purchase: singlePurchase, isConsumable: false }).catch(() => {
          /* ignore */
        });
      }
      setIsLoading(false);
      isBusyRef.current = false;
    }
  }, [config, userId]);

  // -------------------------------------------------------------------------
  // restore()
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
      await RNIap.initConnection();

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
  }, [config, userId]);

  // -------------------------------------------------------------------------
  // purchaseProduct() — consumable or non-consumable one-time purchase
  // -------------------------------------------------------------------------
  const purchaseProduct = useCallback(
    async (productId: string, type: 'consumable' | 'non_consumable'): Promise<PurchaseInfo | null> => {
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

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let purchase: any = null;

      try {
        const platform = getCurrentPlatform();
        await RNIap.initConnection();

        // v15: fetchProducts replaces getProducts
        const products = await RNIap.fetchProducts({ skus: [productId], type: 'in-app' });
        if (!products || !products.length) {
          throw new Error(`[onesub] Product not found in store: ${productId}`);
        }

        // v15: requestPurchase is event-based — purchase arrives via
        // purchaseUpdatedListener. We race the listener promise against the
        // kickoff call (which resolves before the event fires).
        const eventPromise = awaitPurchaseEvent(productId);
        await RNIap.requestPurchase(buildRequestPurchaseArgs(productId, platform, 'in-app'));
        purchase = await eventPromise;
        if (!purchase) {
          return null;
        }

        const receipt = extractReceiptToken(purchase);
        if (!receipt) {
          throw new Error('[onesub] No receipt data in purchase response.');
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

        throw new Error(validationResult.error ?? '[onesub] Purchase validation failed.');
      } catch (err) {
        if (isUserCancelled(err)) return null;
        throw err;
      } finally {
        if (purchase) {
          await RNIap.finishTransaction({
            purchase,
            isConsumable: type === 'consumable',
          }).catch(() => {
            /* ignore — store will re-deliver on next app launch if unfinished */
          });
        }
        setIsLoading(false);
        isBusyRef.current = false;
      }
    },
    [config, userId],
  );

  // -------------------------------------------------------------------------
  // restoreProduct() — restore a one-time purchase (non-consumable)
  // -------------------------------------------------------------------------
  const restoreProduct = useCallback(
    async (productId: string, type: 'consumable' | 'non_consumable'): Promise<PurchaseInfo | null> => {
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
        await RNIap.initConnection();

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
    [config, userId],
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
