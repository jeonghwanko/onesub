import type { SubscriptionInfo, PurchaseInfo, EntitlementStatus } from '@onesub/shared';
import { useOneSubContext } from './OneSubProvider.js';

export interface UseOneSubReturn {
  /** Whether the user currently has an active subscription */
  isActive: boolean;
  /** True while checking status or processing a purchase / restore */
  isLoading: boolean;
  /** Full subscription details from the server, or null */
  subscription: SubscriptionInfo | null;
  /** Start a subscription purchase flow via the native store UI */
  subscribe: () => Promise<void>;
  /** Restore previous purchases (calls the native store and re-validates) */
  restore: () => Promise<void>;
  /**
   * Purchase a consumable or non-consumable product.
   * Returns the recorded PurchaseInfo on success, or null if the user cancelled.
   */
  purchaseProduct: (productId: string, type: 'consumable' | 'non_consumable') => Promise<(PurchaseInfo & { action?: 'new' | 'restored' }) | null>;
  /**
   * Restore a one-time purchase from the native store's history.
   * Returns the recorded PurchaseInfo on success, or null if the store has
   * no record of the product.
   */
  restoreProduct: (productId: string, type: 'consumable' | 'non_consumable') => Promise<(PurchaseInfo & { action?: 'new' | 'restored' }) | null>;
  /**
   * Map of entitlement id → evaluation status, populated from the server's
   * `GET /onesub/entitlements`. Empty map when the server has no entitlements
   * configured. Refreshed automatically after subscribe / purchase / restore.
   */
  entitlements: Record<string, EntitlementStatus>;
  /** Convenience: `entitlements[id]?.active === true`. Safe even if the id is unknown. */
  hasEntitlement: (id: string) => boolean;
  /** Manually re-fetch the entitlements map (e.g. after a server-side state change). */
  refreshEntitlements: () => Promise<void>;
}

/**
 * Primary hook for onesub. Must be used inside <OneSubProvider>.
 *
 * @example
 * ```tsx
 * const { isActive, subscribe, isLoading } = useOneSub();
 *
 * if (!isActive) {
 *   return <Paywall config={paywallConfig} onSubscribe={subscribe} />;
 * }
 * ```
 */
export function useOneSub(): UseOneSubReturn {
  return useOneSubContext();
}
