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
// We attempt a dynamic require so the SDK still loads when it is not installed.
// ---------------------------------------------------------------------------
let RNIap: typeof import('react-native-iap') | null = null;
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
  /** Whether the user currently has an active subscription */
  isActive: boolean;
  /** True while checking status or processing a purchase */
  isLoading: boolean;
  /** Full subscription details, or null when none */
  subscription: SubscriptionInfo | null;
  /** Trigger a subscription purchase flow. Requires react-native-iap to be installed. */
  subscribe: () => Promise<void>;
  /** Restore previous purchases from the store. */
  restore: () => Promise<void>;
  /**
   * Purchase a consumable or non-consumable product.
   * Requires react-native-iap to be installed.
   * Returns the recorded PurchaseInfo on success, or null if the user cancelled.
   */
  purchaseProduct: (productId: string, type: 'consumable' | 'non_consumable') => Promise<PurchaseInfo | null>;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------
const OneSubContext = createContext<OneSubContextValue | null>(null);

/** @internal */
export function useOneSubContext(): OneSubContextValue {
  const ctx = useContext(OneSubContext);
  if (!ctx) {
    throw new Error('[onesub] useOneSub must be used inside <OneSubProvider>');
  }
  return ctx;
}

// ---------------------------------------------------------------------------
// Helper — derive platform product ID
// ---------------------------------------------------------------------------
function getProductId(config: OneSubConfig, platform: 'ios' | 'android'): string {
  if (platform === 'ios') return config.appleProductId ?? config.productId;
  return config.googleProductId ?? config.productId;
}

// ---------------------------------------------------------------------------
// Helper — detect current platform (avoids importing Platform at module level
// so this file can be type-checked in a Node environment too)
// ---------------------------------------------------------------------------
function getCurrentPlatform(): 'ios' | 'android' {
  // react-native's Platform is available at runtime
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Platform } = require('react-native') as typeof import('react-native');
  return Platform.OS === 'ios' ? 'ios' : 'android';
}

// ---------------------------------------------------------------------------
// Helper — detect user cancellation errors from react-native-iap
// ---------------------------------------------------------------------------
function isUserCancelled(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as Record<string, unknown>).code;
  return code === 'E_USER_CANCELLED' || code === 'E_USER_ERROR';
}

// ---------------------------------------------------------------------------
// Provider props
// ---------------------------------------------------------------------------
export interface OneSubProviderProps {
  config: OneSubConfig;
  /** Stable user ID used for server-side status checks and receipt validation */
  userId: string;
  children: React.ReactNode;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------
export function OneSubProvider({ config, userId, children }: OneSubProviderProps) {
  const [isActive, setIsActive] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [subscription, setSubscription] = useState<SubscriptionInfo | null>(null);

  // Guard against duplicate in-flight calls
  const isBusyRef = useRef(false);

  // -------------------------------------------------------------------------
  // On mount: check subscription status from server
  // On unmount: end IAP connection
  // -------------------------------------------------------------------------
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
        // Network errors treated as "not active" — non-fatal
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
      // End IAP connection on unmount to release store resources
      if (RNIap) {
        void RNIap.endConnection().catch(() => {
          // ignore — already disconnected or never connected
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
        '[onesub] react-native-iap is not installed. ' +
          'Add it as a dependency: npm install react-native-iap',
      );
    }

    isBusyRef.current = true;
    setIsLoading(true);

    // Declare purchase outside try so finally can call finishTransaction
    let singlePurchase: Awaited<ReturnType<typeof RNIap.requestSubscription>> | null = null;

    try {
      const platform = getCurrentPlatform();
      const productId = getProductId(config, platform);

      // Init IAP connection
      await RNIap.initConnection();

      // Fetch available products to confirm the product exists
      const subs = await RNIap.getSubscriptions({ skus: [productId] });
      if (!subs.length) {
        throw new Error(`[onesub] Subscription product not found: ${productId}`);
      }

      // Request purchase — this triggers the native store UI
      const purchase = await RNIap.requestSubscription({ sku: productId });

      // Normalise: requestSubscription can return an array or a single object
      singlePurchase = Array.isArray(purchase) ? (purchase[0] ?? null) : purchase;

      if (!singlePurchase) {
        throw new Error('[onesub] No purchase data returned from the store.');
      }

      // Validate with server
      const receiptToken =
        platform === 'ios'
          ? (singlePurchase as { transactionReceipt?: string }).transactionReceipt ?? ''
          : (singlePurchase as { purchaseToken?: string }).purchaseToken ?? '';

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
        throw new Error(result.error ?? '[onesub] Receipt validation failed.');
      }
    } finally {
      // Always finish the transaction — prevents Android 3-day auto-refund.
      // Duplicate-purchase protection is handled server-side (transactionId unique).
      if (singlePurchase) {
        await RNIap!.finishTransaction({ purchase: singlePurchase, isConsumable: false }).catch(() => {
          // ignore finishTransaction errors — store will retry on next app launch
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
        '[onesub] react-native-iap is not installed. ' +
          'Add it as a dependency: npm install react-native-iap',
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
        // No purchase found — re-check server status to stay in sync
        const status = await checkStatus(config.serverUrl, userId);
        setIsActive(status.active);
        setSubscription(status.subscription);
        return;
      }

      const receiptToken =
        platform === 'ios'
          ? (match as { transactionReceipt?: string }).transactionReceipt ?? ''
          : (match as { purchaseToken?: string }).purchaseToken ?? '';

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
        // Server says invalid — refresh from server
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
          '[onesub] react-native-iap is not installed. ' +
            'Add it as a dependency: npm install react-native-iap',
        );
      }

      isBusyRef.current = true;
      setIsLoading(true);

      // Declare outside try so finally can call finishTransaction
      let purchase: Awaited<ReturnType<typeof RNIap.requestPurchase>> | null = null;

      try {
        const platform = getCurrentPlatform();
        await RNIap.initConnection();

        // Confirm the product exists in the store
        const products = await RNIap.getProducts({ skus: [productId] });
        if (!products.length) {
          throw new Error(`[onesub] Product not found in store: ${productId}`);
        }

        // Trigger the native purchase UI
        purchase = await RNIap.requestPurchase({ sku: productId });

        // requestPurchase should never return an array, but guard just in case
        if (!purchase || Array.isArray(purchase)) {
          return null; // user cancelled or unexpected response
        }

        const receipt =
          platform === 'ios'
            ? (purchase as { transactionReceipt?: string }).transactionReceipt ?? ''
            : (purchase as { purchaseToken?: string }).purchaseToken ?? '';

        if (!receipt) {
          throw new Error('[onesub] No receipt data in purchase response.');
        }

        const purchaseType: PurchaseType =
          type === 'consumable' ? PURCHASE_TYPE.CONSUMABLE : PURCHASE_TYPE.NON_CONSUMABLE;

        const result = await validatePurchase(config.serverUrl, {
          platform: platform === 'ios' ? 'apple' : 'google',
          receipt,
          userId,
          productId,
          type: purchaseType,
        });

        if (result.valid && result.purchase) {
          return result.purchase;
        }

        throw new Error(result.error ?? '[onesub] Purchase validation failed.');
      } catch (err) {
        if (isUserCancelled(err)) return null;
        throw err;
      } finally {
        // Always finish the transaction regardless of success/failure.
        // For consumables this releases the pending state on Android.
        // Server-side transactionId unique constraint prevents duplicate credits.
        if (purchase && !Array.isArray(purchase)) {
          await RNIap!.finishTransaction({
            purchase,
            isConsumable: type === 'consumable',
          }).catch(() => {
            // ignore — store will re-deliver on next app launch if unfinished
          });
        }
        setIsLoading(false);
        isBusyRef.current = false;
      }
    },
    [config, userId],
  );

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------
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
