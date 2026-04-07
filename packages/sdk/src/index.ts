// Provider & context
export { OneSubProvider } from './OneSubProvider.js';
export type { OneSubProviderProps, OneSubContextValue } from './OneSubProvider.js';

// Primary hook
export { useOneSub } from './useOneSub.js';
export type { UseOneSubReturn } from './useOneSub.js';

// UI components
export { Paywall } from './Paywall.js';
export type { PaywallProps } from './Paywall.js';

export { PaywallModal } from './PaywallModal.js';
export type { PaywallModalProps } from './PaywallModal.js';

// API utilities (for advanced / custom UI usage)
export { checkStatus, validateReceipt, validatePurchase } from './api.js';

// Re-export shared types for consumer convenience — no need to depend on @onesub/shared separately
export type {
  OneSubConfig,
  PaywallConfig,
  SubscriptionStatus,
  SubscriptionInfo,
  StatusResponse,
  Platform,
  ValidateReceiptRequest,
  ValidateReceiptResponse,
  PurchaseType,
  PurchaseInfo,
  ValidatePurchaseRequest,
  ValidatePurchaseResponse,
  PurchaseStatusResponse,
} from '@onesub/shared';
