import type {
  MetricsActiveResponse,
  MetricsBucket,
  MetricsGroupBy,
  PurchaseInfo,
  SubscriptionInfo,
} from '@onesub/shared';
import { PURCHASE_TYPE, SUBSCRIPTION_STATUS } from '@onesub/shared';
import type {
  ActiveSubscriptionAggregate,
  MetricsRangeAggregate,
  NonConsumablePurchaseAggregate,
} from './store.js';

/**
 * In-memory reduction of store records into the metrics responses.
 *
 * Split out of the route handlers for two reasons. It was duplicated four times
 * — each range endpoint re-implemented the same window filter, the same
 * product/platform tallies, and the same zero-filled daily bucketing — and none
 * of it was reachable by a test without standing up an HTTP server. Both
 * problems go away when the reduction is a pure function of the records.
 *
 * This is deliberately store-agnostic. Aggregating in the application process
 * still costs one full read per query, which is the remaining scaling limit for
 * large deployments; pushing the aggregation down into SQL requires per-store
 * support and is separate work. What lives here is the semantics every store
 * must agree on, so a pushdown implementation has something to be tested
 * against.
 */

/** Minimum shape the tallies need. Both `SubscriptionInfo` and `PurchaseInfo` satisfy it. */
interface Countable {
  productId: string;
  platform: string;
}

/**
 * The count-shaped part of a metrics response; the route adds `from`/`to`.
 *
 * Aliased to the store contract rather than declared separately, so the SQL
 * implementations and this reducer cannot drift into different shapes.
 */
export type RangeAggregate = MetricsRangeAggregate;

export interface RangeAggregateOptions<T> {
  /** Inclusive window bounds, ms-since-epoch. */
  fromMs: number;
  toMs: number;
  groupBy: MetricsGroupBy;
  /**
   * ISO timestamp that places a record in the window and its daily bucket —
   * `purchasedAt` for "started", `expiresAt` for "expired".
   */
  anchor: (record: T) => string;
  /** Records this rejects are ignored entirely (status / type gates). */
  include?: (record: T) => boolean;
}

const MS_PER_DAY = 86_400_000;

function bump(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}

/**
 * UTC `YYYY-MM-DD` for an epoch-ms instant.
 *
 * UTC keeps bucket assignment deterministic regardless of server timezone:
 * Postgres `updated_at` is UTC and `SubscriptionInfo` dates carry explicit zone
 * offsets, so a local-time key would silently shift every boundary when the
 * process moved between regions.
 */
export function utcDateKey(ms: number): string {
  const d = new Date(ms);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Zero-filled daily series across `[fromMs, toMs]`, inclusive of both boundary
 * days. Zero-filling is what lets a chart render a flat stretch as flat rather
 * than as a gap.
 */
export function emptyDailyBuckets(fromMs: number, toMs: number): MetricsBucket[] {
  const out: MetricsBucket[] = [];
  // Snap to UTC midnight so iteration lands on calendar boundaries.
  const start = new Date(fromMs);
  start.setUTCHours(0, 0, 0, 0);
  let cur = start.getTime();
  while (cur <= toMs) {
    out.push({ date: utcDateKey(cur), count: 0 });
    cur += MS_PER_DAY;
  }
  return out;
}

/**
 * Tally records whose anchor timestamp falls inside the window.
 *
 * Records outside the window, and records rejected by `include`, contribute
 * nothing — not to `total`, not to the distributions, not to a bucket.
 */
export function aggregateRange<T extends Countable>(
  records: readonly T[],
  opts: RangeAggregateOptions<T>,
): RangeAggregate {
  const byProduct: Record<string, number> = {};
  const byPlatform: Record<string, number> = {};
  let total = 0;

  const buckets = opts.groupBy === 'day' ? emptyDailyBuckets(opts.fromMs, opts.toMs) : null;
  // date → index, so bucket assignment stays O(1) per record instead of a scan.
  const bucketIndex = buckets ? new Map(buckets.map((b, i) => [b.date, i])) : null;

  for (const record of records) {
    if (opts.include && !opts.include(record)) continue;
    const anchorMs = new Date(opts.anchor(record)).getTime();
    if (Number.isNaN(anchorMs)) continue;
    if (anchorMs < opts.fromMs || anchorMs > opts.toMs) continue;

    total++;
    bump(byProduct, record.productId);
    bump(byPlatform, record.platform);

    if (buckets && bucketIndex) {
      const idx = bucketIndex.get(utcDateKey(anchorMs));
      if (idx !== undefined) buckets[idx]!.count++;
    }
  }

  return { total, byProduct, byPlatform, ...(buckets ? { buckets } : {}) };
}

/** A subscription counts as currently entitled: allowed status AND not yet expired. */
export function isActiveSubscription(sub: SubscriptionInfo, nowMs: number): boolean {
  const statusAllows =
    sub.status === SUBSCRIPTION_STATUS.ACTIVE || sub.status === SUBSCRIPTION_STATUS.GRACE_PERIOD;
  return statusAllows && new Date(sub.expiresAt).getTime() > nowMs;
}

/** A subscription counts as ended: the store recorded it expired or canceled. */
export function isEndedSubscription(sub: SubscriptionInfo): boolean {
  return (
    sub.status === SUBSCRIPTION_STATUS.EXPIRED || sub.status === SUBSCRIPTION_STATUS.CANCELED
  );
}

/** Non-consumables grant an ongoing right; consumables are a spent resource. */
export function isNonConsumable(purchase: PurchaseInfo): boolean {
  return purchase.type === PURCHASE_TYPE.NON_CONSUMABLE;
}

/**
 * Point-in-time entitlement snapshot.
 *
 * `byProduct` is subscriptions-only and `byProductPurchases` is
 * non-consumables-only, so a dashboard can show "subscription mix" and
 * "lifetime mix" as separate panels. `byPlatform` deliberately spans both —
 * it answers "where are my paying users", which is not a per-kind question.
 */
export function aggregateActive(
  subs: readonly SubscriptionInfo[],
  purchases: readonly PurchaseInfo[],
  nowMs: number,
): MetricsActiveResponse {
  return composeActiveResponse(
    aggregateActiveSubscriptions(subs, nowMs),
    aggregateNonConsumablePurchases(purchases),
  );
}

/**
 * Subscription half of the active snapshot.
 *
 * Split from the purchase half so the metrics route can take each from its own
 * store's SQL aggregate, or fall back to this, independently — a deployment can
 * have a Postgres subscription store and a custom purchase store.
 */
export function aggregateActiveSubscriptions(
  subs: readonly SubscriptionInfo[],
  nowMs: number,
): ActiveSubscriptionAggregate {
  const byProduct: Record<string, number> = {};
  const byPlatform: Record<string, number> = {};
  let active = 0;
  let gracePeriod = 0;

  for (const sub of subs) {
    if (!isActiveSubscription(sub, nowMs)) continue;
    active++;
    if (sub.status === SUBSCRIPTION_STATUS.GRACE_PERIOD) gracePeriod++;
    bump(byProduct, sub.productId);
    bump(byPlatform, sub.platform);
  }

  return { active, gracePeriod, byProduct, byPlatform };
}

/** Purchase half of the active snapshot. */
export function aggregateNonConsumablePurchases(
  purchases: readonly PurchaseInfo[],
): NonConsumablePurchaseAggregate {
  const byProduct: Record<string, number> = {};
  const byPlatform: Record<string, number> = {};
  let total = 0;

  for (const purchase of purchases) {
    if (!isNonConsumable(purchase)) continue;
    total++;
    bump(byProduct, purchase.productId);
    bump(byPlatform, purchase.platform);
  }

  return { total, byProduct, byPlatform };
}

/**
 * Assemble the wire response from the two halves.
 *
 * `byProduct` stays subscriptions-only and `byProductPurchases`
 * non-consumables-only, so a dashboard can show "subscription mix" and "lifetime
 * mix" as separate panels. `byPlatform` deliberately spans both — it answers
 * "where are my paying users", which is not a per-kind question.
 */
export function composeActiveResponse(
  subs: ActiveSubscriptionAggregate,
  purchases: NonConsumablePurchaseAggregate,
): MetricsActiveResponse {
  const byPlatform: Record<string, number> = { ...subs.byPlatform };
  for (const [platform, count] of Object.entries(purchases.byPlatform)) {
    byPlatform[platform] = (byPlatform[platform] ?? 0) + count;
  }

  return {
    total: subs.active + purchases.total,
    activeSubscriptions: subs.active,
    gracePeriodSubscriptions: subs.gracePeriod,
    nonConsumablePurchases: purchases.total,
    byProduct: subs.byProduct,
    byProductPurchases: purchases.byProduct,
    byPlatform,
  };
}
