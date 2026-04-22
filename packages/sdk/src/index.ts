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
export { checkStatus, validateReceipt, validatePurchase, checkPurchaseStatus } from './api.js';

// Structured errors — `err.code` is a value from ONESUB_ERROR_CODE.
export { OneSubError, isOneSubError, toOneSubError } from './OneSubError.js';
export { ONESUB_ERROR_CODE } from '@onesub/shared';
export type { OneSubErrorCode, OneSubLogger } from '@onesub/shared';

// SDK logger factory — exported so consumers with custom debug tooling can
// reuse the same formatting. Most apps only need `config.debug: true`.
export { createSdkLogger } from './logger.js';
export type { SdkLogger } from './logger.js';

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
