import type { SubscriptionInfo, PurchaseInfo } from '@onesub/shared';

/**
 * Pluggable subscription store interface.
 * Default is in-memory. Replace with a PostgreSQL/Redis implementation
 * by passing `store` in OneSubServerConfig.
 */
export interface SubscriptionStore {
  save(sub: SubscriptionInfo): Promise<void>;
  getByUserId(userId: string): Promise<SubscriptionInfo | null>;
  getByTransactionId(txId: string): Promise<SubscriptionInfo | null>;
}

/**
 * In-memory implementation — suitable for development and testing.
 * Data is lost on process restart.
 */
export class InMemorySubscriptionStore implements SubscriptionStore {
  private readonly byUserId = new Map<string, SubscriptionInfo>();
  private readonly byTransactionId = new Map<string, SubscriptionInfo>();

  async save(sub: SubscriptionInfo): Promise<void> {
    this.byUserId.set(sub.userId, sub);
    this.byTransactionId.set(sub.originalTransactionId, sub);
  }

  async getByUserId(userId: string): Promise<SubscriptionInfo | null> {
    return this.byUserId.get(userId) ?? null;
  }

  async getByTransactionId(txId: string): Promise<SubscriptionInfo | null> {
    return this.byTransactionId.get(txId) ?? null;
  }
}

/**
 * Pluggable purchase store interface for consumables and non-consumables.
 */
export interface PurchaseStore {
  savePurchase(purchase: PurchaseInfo): Promise<void>;
  getPurchasesByUserId(userId: string): Promise<PurchaseInfo[]>;
  getPurchaseByTransactionId(txId: string): Promise<PurchaseInfo | null>;
  /** For non-consumables: check if a user has already purchased a product. */
  hasPurchased(userId: string, productId: string): Promise<boolean>;
  /**
   * Admin: delete all purchases matching userId + productId.
   * Used by the admin reset endpoint to allow re-testing non-consumables.
   * Returns the number of rows deleted.
   */
  deletePurchases(userId: string, productId: string): Promise<number>;
}

/**
 * In-memory implementation of PurchaseStore — suitable for development and testing.
 * Data is lost on process restart.
 */
export class InMemoryPurchaseStore implements PurchaseStore {
  private readonly byTransactionId = new Map<string, PurchaseInfo>();
  private readonly byUserId = new Map<string, PurchaseInfo[]>();

  async savePurchase(purchase: PurchaseInfo): Promise<void> {
    this.byTransactionId.set(purchase.transactionId, purchase);
    const list = this.byUserId.get(purchase.userId) ?? [];
    list.push(purchase);
    this.byUserId.set(purchase.userId, list);
  }

  async getPurchasesByUserId(userId: string): Promise<PurchaseInfo[]> {
    return this.byUserId.get(userId) ?? [];
  }

  async getPurchaseByTransactionId(txId: string): Promise<PurchaseInfo | null> {
    return this.byTransactionId.get(txId) ?? null;
  }

  async hasPurchased(userId: string, productId: string): Promise<boolean> {
    const purchases = this.byUserId.get(userId);
    if (!purchases) return false;
    return purchases.some((p) => p.productId === productId);
  }

  async deletePurchases(userId: string, productId: string): Promise<number> {
    const list = this.byUserId.get(userId) ?? [];
    const kept = list.filter((p) => p.productId !== productId);
    const deleted = list.length - kept.length;
    this.byUserId.set(userId, kept);
    for (const p of list) {
      if (p.productId === productId) this.byTransactionId.delete(p.transactionId);
    }
    return deleted;
  }
}
