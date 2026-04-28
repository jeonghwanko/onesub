/**
 * @onesub/providers
 *
 * App Store Connect + Google Play API wrappers.
 * Used by @onesub/mcp-server and mimi-seed.
 */

// ── Apple App Store Connect ───────────────────────────────────────────────────

export {
  createSubscription as createAppleSubscription,
  createOneTimePurchase as createAppleOneTimePurchase,
  updateProduct as updateAppleProduct,
  deleteProduct as deleteAppleProduct,
  listProducts as listAppleProducts,
  resolveAppId as resolveAppleAppId,
  findPricePoint as findApplePricePoint,
  APPLE_KRW_COMMON_PRICES,
} from './apple.js';

export type {
  AppleCredentials,
  AppleProductType,
  AppleProductRecord,
  CreateSubscriptionResult as AppleCreateSubscriptionResult,
  CreateOneTimePurchaseResult as AppleCreateOneTimePurchaseResult,
  UpdateProductResult as AppleUpdateProductResult,
  DeleteProductResult as AppleDeleteProductResult,
  FindPricePointResult,
  PricePointMatch,
} from './apple.js';

// ── Google Play Developer ─────────────────────────────────────────────────────

export {
  createSubscription as createGoogleSubscription,
  createOneTimePurchase as createGoogleOneTimePurchase,
  updateProduct as updateGoogleProduct,
  deleteProduct as deleteGoogleProduct,
  listProducts as listGoogleProducts,
} from './google.js';

export type {
  GoogleCredentials,
  GoogleProductType,
  GoogleProductRecord,
  CreateSubscriptionResult as GoogleCreateSubscriptionResult,
  CreateOneTimePurchaseResult as GoogleCreateOneTimePurchaseResult,
  UpdateProductResult as GoogleUpdateProductResult,
  DeleteProductResult as GoogleDeleteProductResult,
} from './google.js';

// ── Shared ────────────────────────────────────────────────────────────────────

export type { RegionPrice } from './apple.js';
