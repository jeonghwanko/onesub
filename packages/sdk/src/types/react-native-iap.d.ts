/**
 * Ambient type declarations for react-native-iap.
 * This is an optional peer dependency — we only need the types used in OneSubProvider.
 * When the real package is installed, its own types take precedence.
 */
declare module 'react-native-iap' {
  export interface ProductPurchase {
    productId: string;
    transactionId?: string;
    transactionReceipt?: string;
    purchaseToken?: string;
    transactionDate?: number;
    [key: string]: unknown;
  }

  export interface Subscription {
    productId: string;
    [key: string]: unknown;
  }

  export interface Product {
    productId: string;
    [key: string]: unknown;
  }

  export function initConnection(): Promise<boolean>;
  export function endConnection(): Promise<void>;
  export function getSubscriptions(params: { skus: string[] }): Promise<Subscription[]>;
  export function getProducts(params: { skus: string[] }): Promise<Product[]>;
  export function requestSubscription(params: { sku: string }): Promise<ProductPurchase | ProductPurchase[]>;
  export function requestPurchase(params: { sku: string }): Promise<ProductPurchase>;
  export function getAvailablePurchases(): Promise<ProductPurchase[]>;
  export function finishTransaction(params: {
    purchase: ProductPurchase;
    isConsumable: boolean;
  }): Promise<string | void>;
}
