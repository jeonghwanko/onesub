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
  purchaseProduct: (productId: string, type: 'consumable' | 'non_consumable') => Promise<PurchaseInfo | null>;
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

      // v15: platform-scoped requestPurchase with type: 'subs'
      const result = await RNIap.requestPurchase(buildRequestPurchaseArgs(productId, platform, 'subs'));

      singlePurchase = Array.isArray(result) ? (result[0] ?? null) : result;
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

        // v15: platform-scoped requestPurchase with type: 'in-app'
        const result = await RNIap.requestPurchase(buildRequestPurchaseArgs(productId, platform, 'in-app'));

        purchase = Array.isArray(result) ? (result[0] ?? null) : result;
        if (!purchase) {
          return null; // user cancelled or no-op
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
          return validationResult.purchase;
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

  const value: OneSubContextValue = {
    isActive,
    isLoading,
    subscription,
    subscribe,
    restore,
    purchaseProduct,
  };

  return <OneSubContext.Provider value={value}>{children}</OneSubContext.Provider>;
}
