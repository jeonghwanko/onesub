import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type {
  MetricsActiveResponse,
  MetricsBucket,
  MetricsCountResponse,
  OneSubServerConfig,
  PurchaseInfo,
  SubscriptionInfo,
} from '@onesub/shared';
import {
  ROUTES,
  SUBSCRIPTION_STATUS,
  PURCHASE_TYPE,
  ONESUB_ERROR_CODE,
} from '@onesub/shared';
import type { PurchaseStore, SubscriptionStore } from '../store.js';
import { log } from '../logger.js';
import { sendError } from '../errors.js';

const ADMIN_SECRET_HEADER = 'x-admin-secret';

/**
 * Read-only aggregate metrics endpoints — gated behind `config.adminSecret`.
 * Returns count-based metrics only (active count, started count, expired count).
 *
 * Revenue metrics (MRR, ARR, LTV) require per-product price configuration the
 * server doesn't currently track; deferred to a follow-up release that adds
 * `config.products: { 'pro_monthly': { price: 9.99, currency: 'USD' } }`.
 *
 * Aggregation strategy: pulls every record via `store.listAll()` and reduces
 * in memory. Fine up to ~100k records; large deployments should optimise the
 * Postgres path with SQL aggregates (separate PR).
 */
export function createMetricsRouter(
  config: OneSubServerConfig,
  store: SubscriptionStore,
  purchaseStore: PurchaseStore,
): Router | null {
  if (!config.adminSecret) return null;

  const router = Router();
  const adminSecret = config.adminSecret;

  // Auth middleware — only protects /onesub/metrics/* (siblings unaffected
  // even when this router is mounted on the parent root).
  router.use('/onesub/metrics', (req, res, next) => {
    const provided = req.headers[ADMIN_SECRET_HEADER];
    if (typeof provided !== 'string' || provided !== adminSecret) {
      sendError(res, 401, ONESUB_ERROR_CODE.INVALID_ADMIN_SECRET, 'INVALID_ADMIN_SECRET');
      return;
    }
    next();
  });

  // ── helpers ──────────────────────────────────────────────────────────────

  const isActiveSub = (sub: SubscriptionInfo, now: number): boolean => {
    const statusAllows =
      sub.status === SUBSCRIPTION_STATUS.ACTIVE ||
      sub.status === SUBSCRIPTION_STATUS.GRACE_PERIOD;
    return statusAllows && new Date(sub.expiresAt).getTime() > now;
  };

  const bump = (map: Record<string, number>, key: string) => {
    map[key] = (map[key] ?? 0) + 1;
  };

  // ── GET /onesub/metrics/active ───────────────────────────────────────────

  router.get(ROUTES.METRICS_ACTIVE, async (_req: Request, res: Response) => {
    try {
      const [subs, purchases] = await Promise.all([
        store.listAll(),
        purchaseStore.listAll(),
      ]);
      const now = Date.now();

      const byProduct: Record<string, number> = {};
      const byPlatform: Record<string, number> = {};
      let activeSubscriptions = 0;
      let gracePeriodSubscriptions = 0;
      let nonConsumablePurchases = 0;

      for (const sub of subs) {
        if (!isActiveSub(sub, now)) continue;
        activeSubscriptions++;
        if (sub.status === SUBSCRIPTION_STATUS.GRACE_PERIOD) {
          gracePeriodSubscriptions++;
        }
        bump(byProduct, sub.productId);
        bump(byPlatform, sub.platform);
      }

      for (const p of purchases) {
        if (p.type !== PURCHASE_TYPE.NON_CONSUMABLE) continue;
        nonConsumablePurchases++;
        // Don't add to byProduct (subscription-only metric for product distribution)
        bump(byPlatform, p.platform);
      }

      const response: MetricsActiveResponse = {
        total: activeSubscriptions + nonConsumablePurchases,
        activeSubscriptions,
        gracePeriodSubscriptions,
        nonConsumablePurchases,
        byProduct,
        byPlatform,
      };
      res.status(200).json(response);
    } catch (err) {
      log.error('[onesub/metrics/active] error:', err);
      sendError(res, 500, ONESUB_ERROR_CODE.STORE_ERROR, 'Internal server error');
    }
  });

  // ── GET /onesub/metrics/started?from=&to=&groupBy= ───────────────────────

  const rangeSchema = z.object({
    from: z.string().min(1),
    to: z.string().min(1),
    groupBy: z.enum(['none', 'day']).optional(),
  });

  type Range = { fromMs: number; toMs: number; groupBy: 'none' | 'day' };

  function parseRange(req: Request): Range | { error: string } {
    const parsed = rangeSchema.safeParse(req.query);
    if (!parsed.success) return { error: 'from and to are required (ISO 8601)' };
    const fromMs = new Date(parsed.data.from).getTime();
    const toMs = new Date(parsed.data.to).getTime();
    if (Number.isNaN(fromMs) || Number.isNaN(toMs)) {
      return { error: 'from / to must be ISO 8601 timestamps' };
    }
    if (fromMs > toMs) return { error: 'from must be ≤ to' };
    return { fromMs, toMs, groupBy: parsed.data.groupBy ?? 'none' };
  }

  // UTC `YYYY-MM-DD` for a given epoch-ms. Used to assign each record to a
  // calendar-day bucket; UTC keeps the result deterministic regardless of
  // server timezone (Postgres `updated_at` is UTC; SubscriptionInfo dates are
  // ISO with explicit zone offsets).
  function utcDateKey(ms: number): string {
    const d = new Date(ms);
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }

  // Zero-fill a daily series across [fromMs, toMs] (inclusive of both
  // boundary days). The route handler then increments the counts.
  function emptyDailyBuckets(fromMs: number, toMs: number): MetricsBucket[] {
    const out: MetricsBucket[] = [];
    // Snap `from` to UTC midnight so iteration steps land on calendar boundaries.
    const start = new Date(fromMs);
    start.setUTCHours(0, 0, 0, 0);
    let cur = start.getTime();
    while (cur <= toMs) {
      out.push({ date: utcDateKey(cur), count: 0 });
      cur += 86_400_000;
    }
    return out;
  }

  router.get(ROUTES.METRICS_STARTED, async (req: Request, res: Response) => {
    const range = parseRange(req);
    if ('error' in range) {
      sendError(res, 400, ONESUB_ERROR_CODE.INVALID_INPUT, range.error);
      return;
    }
    try {
      const subs = await store.listAll();
      const byProduct: Record<string, number> = {};
      const byPlatform: Record<string, number> = {};
      let total = 0;

      // Build a date→index map only when bucketing is requested — keeps the
      // non-bucketed path identical to the previous implementation.
      const buckets =
        range.groupBy === 'day' ? emptyDailyBuckets(range.fromMs, range.toMs) : null;
      const bucketIndex =
        buckets ? new Map(buckets.map((b, i) => [b.date, i])) : null;

      for (const sub of subs) {
        const purchasedMs = new Date(sub.purchasedAt).getTime();
        if (purchasedMs < range.fromMs || purchasedMs > range.toMs) continue;
        total++;
        bump(byProduct, sub.productId);
        bump(byPlatform, sub.platform);
        if (buckets && bucketIndex) {
          const idx = bucketIndex.get(utcDateKey(purchasedMs));
          if (idx !== undefined) buckets[idx]!.count++;
        }
      }

      const response: MetricsCountResponse = {
        from: req.query['from'] as string,
        to: req.query['to'] as string,
        total,
        byProduct,
        byPlatform,
        ...(buckets ? { buckets } : {}),
      };
      res.status(200).json(response);
    } catch (err) {
      log.error('[onesub/metrics/started] error:', err);
      sendError(res, 500, ONESUB_ERROR_CODE.STORE_ERROR, 'Internal server error');
    }
  });

  // ── GET /onesub/metrics/expired?from=&to= ────────────────────────────────

  router.get(ROUTES.METRICS_EXPIRED, async (req: Request, res: Response) => {
    const range = parseRange(req);
    if ('error' in range) {
      sendError(res, 400, ONESUB_ERROR_CODE.INVALID_INPUT, range.error);
      return;
    }
    try {
      const subs = await store.listAll();
      const byProduct: Record<string, number> = {};
      const byPlatform: Record<string, number> = {};
      let total = 0;

      const buckets =
        range.groupBy === 'day' ? emptyDailyBuckets(range.fromMs, range.toMs) : null;
      const bucketIndex =
        buckets ? new Map(buckets.map((b, i) => [b.date, i])) : null;

      for (const sub of subs) {
        // Counted only if currently expired or canceled — a record that's
        // still active doesn't qualify even if its expiresAt happened to fall
        // inside the window (e.g. mid-period billing renewal).
        if (
          sub.status !== SUBSCRIPTION_STATUS.EXPIRED &&
          sub.status !== SUBSCRIPTION_STATUS.CANCELED
        ) continue;
        const expiredMs = new Date(sub.expiresAt).getTime();
        if (expiredMs < range.fromMs || expiredMs > range.toMs) continue;
        total++;
        bump(byProduct, sub.productId);
        bump(byPlatform, sub.platform);
        if (buckets && bucketIndex) {
          const idx = bucketIndex.get(utcDateKey(expiredMs));
          if (idx !== undefined) buckets[idx]!.count++;
        }
      }

      const response: MetricsCountResponse = {
        from: req.query['from'] as string,
        to: req.query['to'] as string,
        total,
        byProduct,
        byPlatform,
        ...(buckets ? { buckets } : {}),
      };
      res.status(200).json(response);
    } catch (err) {
      log.error('[onesub/metrics/expired] error:', err);
      sendError(res, 500, ONESUB_ERROR_CODE.STORE_ERROR, 'Internal server error');
    }
  });

  return router;
}

export type { PurchaseInfo, SubscriptionInfo };
