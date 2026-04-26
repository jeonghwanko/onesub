import type { SubscriptionInfo, PurchaseInfo, SubscriptionStatus, Platform } from '@onesub/shared';

/** Filter options for SubscriptionStore.listFiltered. All fields optional. */
export interface ListFilteredOptions {
  userId?: string;
  status?: SubscriptionStatus;
  productId?: string;
  platform?: Platform;
  /** Max items to return. Defaults to 50, capped at 200 by the route handler. */
  limit?: number;
  /** Pagination cursor. Defaults to 0. */
  offset?: number;
}

/** Result of SubscriptionStore.listFiltered. */
export interface ListFilteredResult {
  items: SubscriptionInfo[];
  /** Total matches before limit/offset — used for pagination UI. */
  total: number;
  limit: number;
  offset: number;
}

/**
 * Pluggable subscription store interface.
 * Default is in-memory. Replace with a PostgreSQL/Redis implementation
 * by passing `store` in OneSubServerConfig.
 */
export interface SubscriptionStore {
  save(sub: SubscriptionInfo): Promise<void>;
  /**
   * Returns the most recent subscription for the user, or null if none exist.
   * Use this for legacy single-product checks (`/onesub/status`); for
   * entitlements that span multiple productIds, prefer `getAllByUserId`.
   */
  getByUserId(userId: string): Promise<SubscriptionInfo | null>;
  getByTransactionId(txId: string): Promise<SubscriptionInfo | null>;
  /**
   * Returns every subscription record in the store. Used by metrics
   * aggregation. Hosts shouldn't expose this through unauthenticated routes —
   * the built-in `/onesub/metrics/*` endpoints gate it behind `adminSecret`.
   */
  listAll(): Promise<SubscriptionInfo[]>;
  /**
   * Filtered, paginated subscription list. Used by the dashboard's
   * subscriptions page and any admin tool that needs to enumerate records
   * without pulling the entire table.
   *
   * Filter semantics: each non-undefined field is an AND condition.
   * Sorting: most-recently-updated first (PostgresStore uses `updated_at DESC`;
   * InMemoryStore approximates via insertion order with newest at the front).
   */
  listFiltered(opts: ListFilteredOptions): Promise<ListFilteredResult>;
  /**
   * Returns every subscription record for the user (across all productIds),
   * ordered most-recent-first. Used by entitlement evaluation, which needs to
   * see all of a user's active subscriptions to decide whether any of them
   * grants the requested entitlement.
   *
   * Implementations: in-memory currently coalesces by userId so this returns
   * at most one row; Postgres returns the full history.
   */
  getAllByUserId(userId: string): Promise<SubscriptionInfo[]>;
}

/**
 * In-memory implementation — suitable for development and testing.
 * Data is lost on process restart.
 */
export class InMemorySubscriptionStore implements SubscriptionStore {
  // Multiple records per user (different originalTransactionIds) — required
  // for entitlement evaluation across multiple productIds. Ordering is
  // last-written-first so getByUserId returns "most recent" naturally.
  private readonly byUserId = new Map<string, SubscriptionInfo[]>();
  private readonly byTransactionId = new Map<string, SubscriptionInfo>();

  async save(sub: SubscriptionInfo): Promise<void> {
    this.byTransactionId.set(sub.originalTransactionId, sub);

    const existing = this.byUserId.get(sub.userId) ?? [];
    // Replace any prior record with the same originalTransactionId, then
    // unshift to the front so the latest write is index 0 (= getByUserId result).
    const filtered = existing.filter((s) => s.originalTransactionId !== sub.originalTransactionId);
    filtered.unshift(sub);
    this.byUserId.set(sub.userId, filtered);
  }

  async getByUserId(userId: string): Promise<SubscriptionInfo | null> {
    const list = this.byUserId.get(userId);
    return list?.[0] ?? null;
  }

  async getAllByUserId(userId: string): Promise<SubscriptionInfo[]> {
    return [...(this.byUserId.get(userId) ?? [])];
  }

  async getByTransactionId(txId: string): Promise<SubscriptionInfo | null> {
    return this.byTransactionId.get(txId) ?? null;
  }

  async listAll(): Promise<SubscriptionInfo[]> {
    return [...this.byTransactionId.values()];
  }

  async listFiltered(opts: ListFilteredOptions): Promise<ListFilteredResult> {
    const limit = opts.limit ?? 50;
    const offset = opts.offset ?? 0;
    // Iterate via byUserId so insertion-order is "newest first" within each
    // user (matches PostgresStore's `updated_at DESC` semantic). Across users
    // we collect in Map iteration order — stable for a given run.
    const all: SubscriptionInfo[] = [];
    for (const list of this.byUserId.values()) {
      for (const s of list) all.push(s);
    }
    const filtered = all.filter((s) => {
      if (opts.userId && s.userId !== opts.userId) return false;
      if (opts.status && s.status !== opts.status) return false;
      if (opts.productId && s.productId !== opts.productId) return false;
      if (opts.platform && s.platform !== opts.platform) return false;
      return true;
    });
    return {
      items: filtered.slice(offset, offset + limit),
      total: filtered.length,
      limit,
      offset,
    };
  }
}

/**
 * Pluggable purchase store interface for consumables and non-consumables.
 */
export interface PurchaseStore {
  savePurchase(purchase: PurchaseInfo): Promise<void>;
  getPurchasesByUserId(userId: string): Promise<PurchaseInfo[]>;
  getPurchaseByTransactionId(txId: string): Promise<PurchaseInfo | null>;
  /** Returns every purchase record. Used by metrics aggregation; admin-gated. */
  listAll(): Promise<PurchaseInfo[]>;
  /** For non-consumables: check if a user has already purchased a product. */
  hasPurchased(userId: string, productId: string): Promise<boolean>;
  /**
   * Admin: delete all purchases matching userId + productId.
   * Used by the admin reset endpoint to allow re-testing non-consumables.
   * Returns the number of rows deleted.
   */
  deletePurchases(userId: string, productId: string): Promise<number>;
  /**
   * Delete a single purchase by its transactionId.
   * Used by the refund/voided-purchase webhook path to revoke entitlement
   * for the exact transaction that was refunded — without touching sibling
   * consumable purchases of the same user/product.
   * Returns true if a row was deleted.
   */
  deletePurchaseByTransactionId(transactionId: string): Promise<boolean>;
  /**
   * Reassign a transaction's owner to a new userId.
   * Used when the validate route encounters TRANSACTION_BELONGS_TO_OTHER_USER
   * for a genuinely-signed JWS — the Apple receipt proves the caller owns the
   * original Apple account, so it's safe to transfer ownership (device
   * reinstall, account migration).
   * Returns true if a row was updated, false if the transactionId was not found.
   */
  reassignPurchase(transactionId: string, newUserId: string): Promise<boolean>;
}

/**
 * In-memory implementation of PurchaseStore — suitable for development and testing.
 * Data is lost on process restart.
 */
export class InMemoryPurchaseStore implements PurchaseStore {
  private readonly byTransactionId = new Map<string, PurchaseInfo>();
  private readonly byUserId = new Map<string, PurchaseInfo[]>();

  async savePurchase(purchase: PurchaseInfo): Promise<void> {
    const existing = this.byTransactionId.get(purchase.transactionId);
    if (existing) {
      if (existing.userId !== purchase.userId) {
        const err = new Error('TRANSACTION_BELONGS_TO_OTHER_USER') as Error & { code?: string };
        err.code = 'TRANSACTION_BELONGS_TO_OTHER_USER';
        throw err;
      }
      return; // same user — idempotent
    }
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

  async reassignPurchase(transactionId: string, newUserId: string): Promise<boolean> {
    const existing = this.byTransactionId.get(transactionId);
    if (!existing) return false;
    const oldUserId = existing.userId;
    if (oldUserId === newUserId) return true;
    const updated = { ...existing, userId: newUserId };
    this.byTransactionId.set(transactionId, updated);
    // remove from old userId index
    const oldList = (this.byUserId.get(oldUserId) ?? []).filter((p) => p.transactionId !== transactionId);
    if (oldList.length) this.byUserId.set(oldUserId, oldList);
    else this.byUserId.delete(oldUserId);
    // add to new userId index
    const newList = this.byUserId.get(newUserId) ?? [];
    newList.push(updated);
    this.byUserId.set(newUserId, newList);
    return true;
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

  async listAll(): Promise<PurchaseInfo[]> {
    return [...this.byTransactionId.values()];
  }

  async deletePurchaseByTransactionId(transactionId: string): Promise<boolean> {
    const existing = this.byTransactionId.get(transactionId);
    if (!existing) return false;
    this.byTransactionId.delete(transactionId);
    const list = (this.byUserId.get(existing.userId) ?? []).filter(
      (p) => p.transactionId !== transactionId,
    );
    if (list.length) this.byUserId.set(existing.userId, list);
    else this.byUserId.delete(existing.userId);
    return true;
  }
}
