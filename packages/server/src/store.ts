import { isStaleSnapshot } from './lifecycle.js';
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

// ---------------------------------------------------------------------------
// Metrics aggregates
//
// The `/onesub/metrics/*` routes need counts, not records. A store that can
// compute them itself — `GROUP BY` in SQL — spares the process reading every
// row and reducing it on the event loop. These methods are OPTIONAL: a store
// without them falls back to `listAll()` plus the in-memory reduction in
// `metrics-aggregate.ts`, which is the same answer at O(rows) cost.
//
// `metrics-aggregate.ts` is the executable definition of these shapes. Any
// SQL implementation has to reproduce it exactly, including the UTC calendar-day
// bucket boundaries and the inclusive window — which is what the equivalence
// tests in `postgres-store.test.ts` assert, by running both and comparing.
// ---------------------------------------------------------------------------

/** One day of a daily series. `date` is a UTC `YYYY-MM-DD`. */
export interface MetricsDayBucket {
  date: string;
  count: number;
}

/** Window to aggregate over. Both bounds are inclusive. */
export interface MetricsRangeQuery {
  from: Date;
  to: Date;
  /** `'day'` additionally fills a zero-filled bucket per UTC day in the window. */
  groupBy: 'none' | 'day';
}

/** Counts for a windowed query. */
export interface MetricsRangeAggregate {
  total: number;
  byProduct: Record<string, number>;
  byPlatform: Record<string, number>;
  /** Present only for `groupBy: 'day'`; zero-filled across the whole window. */
  buckets?: MetricsDayBucket[];
}

/** Point-in-time counts for subscriptions that currently grant entitlement. */
export interface ActiveSubscriptionAggregate {
  /** status active|grace_period AND not yet expired. */
  active: number;
  /** The grace_period subset of `active` — the at-risk cohort. */
  gracePeriod: number;
  byProduct: Record<string, number>;
  byPlatform: Record<string, number>;
}

/** Counts for non-consumable purchases (lifetime products). */
export interface NonConsumablePurchaseAggregate {
  total: number;
  byProduct: Record<string, number>;
  byPlatform: Record<string, number>;
}

/**
 * Pluggable subscription store interface.
 * Default is in-memory. Replace with a PostgreSQL/Redis implementation
 * by passing `store` in OneSubServerConfig.
 */
export interface SubscriptionStore {
  /**
   * Upsert by `originalTransactionId`. Must not overwrite a stored record whose
   * `stateAsOf` is newer than `sub.stateAsOf` (see lifecycle.ts), and must make
   * that check atomically with the write: routes check first, but two deliveries
   * processed at once would otherwise both pass and the older could land last.
   * A write without `stateAsOf`, or onto a record without one, always applies.
   */
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
   * Sorting: most-recently-updated first, across all users (Postgres
   * `updated_at DESC`, Redis save-time score, in-memory write order).
   */
  listFiltered(opts: ListFilteredOptions): Promise<ListFilteredResult>;
  /**
   * Returns every subscription record for the user (across all productIds),
   * ordered most-recent-first. Used by entitlement evaluation, which needs to
   * see all of a user's active subscriptions to decide whether any of them
   * grants the requested entitlement.
   *
   * All three built-in implementations return the user's full set, one record
   * per `originalTransactionId`. "Most-recent-first" is last-written-first for
   * the in-memory store and `updated_at DESC` for Postgres/Redis.
   */
  getAllByUserId(userId: string): Promise<SubscriptionInfo[]>;
  /**
   * OPTIONAL. Counts of subscriptions currently granting entitlement, as of
   * `now`. Equivalent to `aggregateActiveSubscriptions(await listAll(), now)`.
   */
  aggregateActive?(now: Date): Promise<ActiveSubscriptionAggregate>;
  /**
   * OPTIONAL. Subscriptions whose `purchasedAt` falls in the window, whatever
   * their current status — a cohort-start count. Equivalent to
   * `aggregateRange(await listAll(), { anchor: purchasedAt, ... })`.
   */
  aggregateStarted?(query: MetricsRangeQuery): Promise<MetricsRangeAggregate>;
  /**
   * OPTIONAL. Subscriptions that are currently expired or canceled AND whose
   * `expiresAt` falls in the window. A still-active record does not count even
   * if its expiry lands inside the window. Equivalent to
   * `aggregateRange(await listAll(), { anchor: expiresAt, include: isEnded })`.
   */
  aggregateExpired?(query: MetricsRangeQuery): Promise<MetricsRangeAggregate>;
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
  // Write order across all users, for listFiltered's newest-first contract.
  // Postgres sorts by `updated_at`, Redis by a save-time score; this is the
  // same thing without a clock, so two writes in one millisecond still order.
  private readonly writeSeq = new Map<string, number>();
  private seq = 0;

  async save(sub: SubscriptionInfo): Promise<void> {
    // Synchronous from here on, so the check and the write cannot interleave.
    if (isStaleSnapshot(this.byTransactionId.get(sub.originalTransactionId), sub.stateAsOf)) return;
    // If this transaction was previously bound to a different userId (the
    // validate route rebinds ownership on re-validation), remove the stale
    // copy from the old user's index — otherwise webhooks (which update by
    // transactionId) can never touch it and the old user keeps a frozen
    // 'active' record forever.
    const prev = this.byTransactionId.get(sub.originalTransactionId);
    if (prev && prev.userId !== sub.userId) {
      const oldList = (this.byUserId.get(prev.userId) ?? []).filter(
        (s) => s.originalTransactionId !== sub.originalTransactionId,
      );
      if (oldList.length) this.byUserId.set(prev.userId, oldList);
      else this.byUserId.delete(prev.userId);
    }

    this.byTransactionId.set(sub.originalTransactionId, sub);
    this.writeSeq.set(sub.originalTransactionId, ++this.seq);

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
    // Most-recently-written first across all users, matching Postgres's
    // `updated_at DESC`. (This used to walk the per-user lists in Map order,
    // which is newest-first only within a user.)
    const seqOf = (s: SubscriptionInfo) => this.writeSeq.get(s.originalTransactionId) ?? 0;
    const all = [...this.byTransactionId.values()].sort((a, b) => seqOf(b) - seqOf(a));
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
  /**
   * Record a purchase. Idempotent for the same transactionId and user. Throws
   * `purchaseConflict(...)` — `TRANSACTION_BELONGS_TO_OTHER_USER` when the
   * transactionId is another user's, `NON_CONSUMABLE_ALREADY_OWNED` when the
   * user already holds this non-consumable under a different transactionId.
   */
  savePurchase(purchase: PurchaseInfo): Promise<void>;
  /**
   * Every purchase for the user, most-recent-first (by `purchasedAt`).
   *
   * Unbounded: a user with a long consumable history has a long row set. Prefer
   * `getPurchasesForProduct` when only one product matters.
   */
  getPurchasesByUserId(userId: string): Promise<PurchaseInfo[]>;
  /**
   * Purchases for one `userId` + `productId`, most-recent-first.
   *
   * OPTIONAL. When a store does not implement it, callers fall back to
   * `getPurchasesByUserId` and filter in process — correct, but it transfers
   * every row the user has. That is the hot path for non-consumable validation:
   * a user who has bought thousands of consumables paid for all of them on every
   * lifetime-product purchase. Implement this and the same answer comes from an
   * index (`WHERE user_id = $1 AND product_id = $2` in Postgres, the
   * `user_product` set in Redis).
   *
   * Optional rather than required so existing custom `PurchaseStore`
   * implementations keep compiling; all three built-in stores implement it.
   */
  getPurchasesForProduct?(userId: string, productId: string): Promise<PurchaseInfo[]>;
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
   * Throws `NON_CONSUMABLE_ALREADY_OWNED` (and moves nothing) when the new user
   * already holds this non-consumable.
   */
  reassignPurchase(transactionId: string, newUserId: string): Promise<boolean>;
  /**
   * OPTIONAL. Counts of non-consumable purchases. Consumables are excluded —
   * they grant a spent resource, not an ongoing right. Equivalent to
   * `aggregateNonConsumablePurchases(await listAll())`.
   */
  aggregateNonConsumable?(): Promise<NonConsumablePurchaseAggregate>;
  /**
   * OPTIONAL. Non-consumable purchases whose `purchasedAt` falls in the window.
   * Equivalent to
   * `aggregateRange(await listAll(), { anchor: purchasedAt, include: isNonConsumable })`.
   */
  aggregateStarted?(query: MetricsRangeQuery): Promise<MetricsRangeAggregate>;
}

/**
 * The error a PurchaseStore throws for a rule it enforces. Every built-in store
 * throws exactly this shape, so routes can map `code` to a status without
 * knowing which store is behind them:
 *
 * - `TRANSACTION_BELONGS_TO_OTHER_USER` — the transactionId is recorded for a
 *   different user (also the loser of a concurrent claim).
 * - `NON_CONSUMABLE_ALREADY_OWNED` — the user already has a non-consumable row
 *   for this product under another transactionId. Postgres enforces this with a
 *   partial unique index; the other stores check it themselves.
 */
export function purchaseConflict(
  code: 'TRANSACTION_BELONGS_TO_OTHER_USER' | 'NON_CONSUMABLE_ALREADY_OWNED',
): Error & { code: string } {
  const err = new Error(code) as Error & { code: string };
  err.code = code;
  return err;
}

/** Insert keeping the list most-recent-first by purchasedAt. */
function insertByPurchasedAt(list: PurchaseInfo[], purchase: PurchaseInfo): void {
  const at = Date.parse(purchase.purchasedAt);
  const idx = list.findIndex((p) => Date.parse(p.purchasedAt) < at);
  if (idx === -1) list.push(purchase);
  else list.splice(idx, 0, purchase);
}

function ownsNonConsumable(list: PurchaseInfo[], productId: string): boolean {
  return list.some((p) => p.type === 'non_consumable' && p.productId === productId);
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
      if (existing.userId !== purchase.userId) throw purchaseConflict('TRANSACTION_BELONGS_TO_OTHER_USER');
      return; // same user — idempotent
    }
    const list = this.byUserId.get(purchase.userId) ?? [];
    if (purchase.type === 'non_consumable' && ownsNonConsumable(list, purchase.productId)) {
      throw purchaseConflict('NON_CONSUMABLE_ALREADY_OWNED');
    }
    this.byTransactionId.set(purchase.transactionId, purchase);
    // Most-recent-first by purchasedAt, matching what Postgres
    // (`ORDER BY purchased_at DESC`) and Redis (`zrevrange`) return — so
    // `/onesub/purchase/status` has the same order in dev and prod.
    insertByPurchasedAt(list, purchase);
    this.byUserId.set(purchase.userId, list);
  }

  async getPurchasesByUserId(userId: string): Promise<PurchaseInfo[]> {
    return [...(this.byUserId.get(userId) ?? [])];
  }

  async getPurchasesForProduct(userId: string, productId: string): Promise<PurchaseInfo[]> {
    // No secondary index here — this store is for development and tests, where
    // the row count is small. It exists so all three built-ins agree on the
    // interface and on ordering.
    return (this.byUserId.get(userId) ?? []).filter((p) => p.productId === productId);
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
    const newList = this.byUserId.get(newUserId) ?? [];
    if (existing.type === 'non_consumable' && ownsNonConsumable(newList, existing.productId)) {
      throw purchaseConflict('NON_CONSUMABLE_ALREADY_OWNED');
    }
    const updated = { ...existing, userId: newUserId };
    this.byTransactionId.set(transactionId, updated);
    // remove from old userId index
    const oldList = (this.byUserId.get(oldUserId) ?? []).filter((p) => p.transactionId !== transactionId);
    if (oldList.length) this.byUserId.set(oldUserId, oldList);
    else this.byUserId.delete(oldUserId);
    insertByPurchasedAt(newList, updated);
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
