import type { SubscriptionInfo } from '@onesub/shared';

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
