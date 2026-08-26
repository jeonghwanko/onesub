import type { buildRequestPurchaseArgs } from './iapRequest.js';

export interface IapEventSubscription {
  remove(): void;
}

/**
 * Runtime surface OneSub consumes from the optional react-native-iap peer.
 * The CI-only peer contract assigns the real v15 module to this interface.
 */
export interface ReactNativeIapAdapter {
  initConnection(): Promise<boolean | void>;
  endConnection?(): Promise<unknown>;
  purchaseUpdatedListener(listener: (purchase: any) => void): IapEventSubscription;
  purchaseErrorListener(listener: (error: any) => void): IapEventSubscription;
  fetchProducts(options: { skus: string[]; type: 'in-app' | 'subs' }): Promise<any[] | null>;
  requestPurchase(options: ReturnType<typeof buildRequestPurchaseArgs>): Promise<unknown>;
  getAvailablePurchases(): Promise<any[]>;
  finishTransaction(options: { purchase: any; isConsumable: boolean }): Promise<unknown>;
}
