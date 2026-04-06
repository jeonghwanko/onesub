import type { SubscriptionInfo } from '@onesub/shared';
import { useOneSubContext } from './OneSubProvider.js';

export interface UseOneSubReturn {
  /** Whether the user currently has an active subscription */
  isActive: boolean;
  /** True while checking status or processing a purchase / restore */
  isLoading: boolean;
  /** Full subscription details from the server, or null */
  subscription: SubscriptionInfo | null;
  /** Start a purchase flow via the native store UI */
  subscribe: () => Promise<void>;
  /** Restore previous purchases (calls the native store and re-validates) */
  restore: () => Promise<void>;
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
