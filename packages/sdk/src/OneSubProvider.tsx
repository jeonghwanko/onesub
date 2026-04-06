import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import type { OneSubConfig, SubscriptionInfo } from '@onesub/shared';
import { checkStatus, validateReceipt } from './api.js';

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
  /** Trigger a purchase flow. Requires react-native-iap to be installed. */
  subscribe: () => Promise<void>;
  /** Restore previous purchases from the store. */
  restore: () => Promise<void>;
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

    try {
      const platform = getCurrentPlatform();
      const productId = getProductId(config, platform);

      // Init IAP connection
      await RNIap.initConnection();

      // Fetch available products to confirm the product exists
      await RNIap.getSubscriptions({ skus: [productId] });

      // Request purchase — this triggers the native store UI
      const purchase = await RNIap.requestSubscription({ sku: productId });

      if (!purchase) {
        throw new Error('[onesub] Purchase was cancelled or returned empty.');
      }

      // Normalise: requestSubscription can return an array or a single object
      const singlePurchase = Array.isArray(purchase) ? purchase[0] : purchase;

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

        // Acknowledge/finish the transaction so the store doesn't refund it
        await RNIap.finishTransaction({ purchase: singlePurchase, isConsumable: false });
      } else {
        throw new Error(result.error ?? '[onesub] Receipt validation failed.');
      }
    } finally {
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
      const match = purchases.find((p) => p.productId === productId);

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
  // Render
  // -------------------------------------------------------------------------
  const value: OneSubContextValue = {
    isActive,
    isLoading,
    subscription,
    subscribe,
    restore,
  };

  return <OneSubContext.Provider value={value}>{children}</OneSubContext.Provider>;
}
