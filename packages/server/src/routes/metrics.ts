import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type {
  MetricsActiveResponse,
  MetricsCountResponse,
  MetricsGroupBy,
  OneSubServerConfig,
  PurchaseInfo,
  SubscriptionInfo,
} from '@onesub/shared';
import { ROUTES, ONESUB_ERROR_CODE } from '@onesub/shared';
import type { PurchaseStore, SubscriptionStore } from '../store.js';
import { log } from '../logger.js';
import { sendError } from '../errors.js';
import { secretsEqual } from './secret-compare.js';
import {
  aggregateActive,
  aggregateRange,
  isEndedSubscription,
  isNonConsumable,
  type RangeAggregate,
} from '../metrics-aggregate.js';
import { createMetricsCache } from '../metrics-cache.js';

const ADMIN_SECRET_HEADER = 'x-admin-secret';

/** Freshness bound when the host does not configure one. */
export const DEFAULT_METRICS_CACHE_TTL_SECONDS = 30;

/**
 * Read-only aggregate metrics endpoints — gated behind `config.adminSecret`.
 * Returns count-based metrics only (active count, started count, expired count).
 *
 * Revenue metrics (MRR, ARR, LTV) require per-product price configuration the
 * server doesn't currently track; deferred to a follow-up release that adds
 * `config.products: { 'pro_monthly': { price: 9.99, currency: 'USD' } }`.
 *
 * Aggregation strategy: reads every record via `store.listAll()` and reduces in
 * memory (see `metrics-aggregate.ts` for the reduction, which is where the
 * semantics are tested). That is one full read per computed response, so
 * responses are cached for `config.metricsCacheTtlSeconds` to bound how often
 * it happens — see `metrics-cache.ts`. Removing the per-response scan entirely
 * needs SQL-side aggregation, which is per-store work and still pending.
 */
export function createMetricsRouter(
  config: OneSubServerConfig,
  store: SubscriptionStore,
  purchaseStore: PurchaseStore,
): Router | null {
  if (!config.adminSecret) return null;

  const router = Router();
  const adminSecret = config.adminSecret;
  const metricsCache = createMetricsCache(
    config.metricsCacheTtlSeconds ?? DEFAULT_METRICS_CACHE_TTL_SECONDS,
  );

  // Auth middleware — only protects /onesub/metrics/* (siblings unaffected
  // even when this router is mounted on the parent root).
  router.use('/onesub/metrics', (req, res, next) => {
    const provided = req.headers[ADMIN_SECRET_HEADER];
    if (typeof provided !== 'string' || !secretsEqual(provided, adminSecret)) {
      sendError(res, 401, ONESUB_ERROR_CODE.INVALID_ADMIN_SECRET, 'INVALID_ADMIN_SECRET');
      return;
    }
    next();
  });

  // ── GET /onesub/metrics/active ───────────────────────────────────────────

  router.get(ROUTES.METRICS_ACTIVE, async (_req: Request, res: Response) => {
    try {
      // Keyed on the TTL grid rather than the exact instant, so concurrent and
      // rapid-repeat refreshes share one computation.
      const response = await metricsCache.resolve<MetricsActiveResponse>(
        ['active', metricsCache.quantizeToWindow(Date.now())],
        async () => {
          const [subs, purchases] = await Promise.all([store.listAll(), purchaseStore.listAll()]);
          return aggregateActive(subs, purchases, Date.now());
        },
      );
      res.status(200).json(response);
    } catch (err) {
      log.error('[onesub/metrics/active] error:', err);
      sendError(res, 500, ONESUB_ERROR_CODE.STORE_ERROR, 'Internal server error');
    }
  });

  // ── windowed endpoints ───────────────────────────────────────────────────

  const rangeSchema = z.object({
    from: z.string().min(1),
    to: z.string().min(1),
    groupBy: z.enum(['none', 'day']).optional(),
  });

  type Range = { fromMs: number; toMs: number; groupBy: MetricsGroupBy };

  // groupBy=day zero-fills one bucket object per calendar day, so an
  // unbounded range (e.g. from=0001-01-01) would allocate millions of
  // buckets from a single request. Cap the span at a year of daily buckets;
  // ranges without groupBy stay uncapped (they only produce totals).
  const MAX_DAY_BUCKET_SPAN_DAYS = 366;
  const MAX_DAY_BUCKET_SPAN_MS = MAX_DAY_BUCKET_SPAN_DAYS * 86_400_000;

  function parseRange(req: Request): Range | { error: string } {
    const parsed = rangeSchema.safeParse(req.query);
    if (!parsed.success) return { error: 'from and to are required (ISO 8601)' };
    const fromMs = new Date(parsed.data.from).getTime();
    const toMs = new Date(parsed.data.to).getTime();
    if (Number.isNaN(fromMs) || Number.isNaN(toMs)) {
      return { error: 'from / to must be ISO 8601 timestamps' };
    }
    if (fromMs > toMs) return { error: 'from must be ≤ to' };
    const groupBy = parsed.data.groupBy ?? 'none';
    if (groupBy === 'day' && toMs - fromMs > MAX_DAY_BUCKET_SPAN_MS) {
      return {
        error: `groupBy=day supports a range of at most ${MAX_DAY_BUCKET_SPAN_DAYS} days — narrow the from/to window or omit groupBy`,
      };
    }
    return { fromMs, toMs, groupBy };
  }

  /**
   * Shared handler for the three windowed endpoints. They differ only in which
   * store they read, which records qualify, and which timestamp anchors a
   * record in the window — so that is all each one supplies.
   *
   * The response echoes the caller's own `from`/`to`, not the quantized cache
   * key, so a client always sees the window it asked about.
   */
  function windowed<T extends { productId: string; platform: string }>(
    name: string,
    load: () => Promise<readonly T[]>,
    anchor: (record: T) => string,
    include?: (record: T) => boolean,
  ) {
    return async (req: Request, res: Response): Promise<void> => {
      const range = parseRange(req);
      if ('error' in range) {
        sendError(res, 400, ONESUB_ERROR_CODE.INVALID_INPUT, range.error);
        return;
      }
      try {
        const aggregate = await metricsCache.resolve<RangeAggregate>(
          [
            name,
            metricsCache.quantizeToWindow(range.fromMs),
            metricsCache.quantizeToWindow(range.toMs),
            range.groupBy,
          ],
          async () =>
            aggregateRange(await load(), {
              fromMs: range.fromMs,
              toMs: range.toMs,
              groupBy: range.groupBy,
              anchor,
              ...(include ? { include } : {}),
            }),
        );

        const response: MetricsCountResponse = {
          from: req.query['from'] as string,
          to: req.query['to'] as string,
          ...aggregate,
        };
        res.status(200).json(response);
      } catch (err) {
        log.error(`[onesub/metrics/${name}] error:`, err);
        sendError(res, 500, ONESUB_ERROR_CODE.STORE_ERROR, 'Internal server error');
      }
    };
  }

  // ── GET /onesub/metrics/started?from=&to=&groupBy= ───────────────────────
  // Subscriptions whose purchasedAt falls in the window, regardless of their
  // current status — this is a cohort-start count, not a live-state count.
  router.get(
    ROUTES.METRICS_STARTED,
    windowed<SubscriptionInfo>('started', () => store.listAll(), (sub) => sub.purchasedAt),
  );

  // ── GET /onesub/metrics/expired?from=&to= ────────────────────────────────
  // Counted only if currently expired or canceled — a record that's still
  // active doesn't qualify even if its expiresAt happened to fall inside the
  // window (e.g. mid-period billing renewal).
  router.get(
    ROUTES.METRICS_EXPIRED,
    windowed<SubscriptionInfo>(
      'expired',
      () => store.listAll(),
      (sub) => sub.expiresAt,
      isEndedSubscription,
    ),
  );

  // ── GET /onesub/metrics/purchases/started?from=&to=&groupBy= ─────────────
  // Counts non-consumable purchases (lifetime products) by purchasedAt within
  // the window. Backs the dashboard's Purchases timeseries so hosts that
  // sell only lifetime products get a meaningful growth signal even when they
  // have no subscription data.
  //
  // Consumables are excluded — they grant a one-time resource (coins, lives),
  // not an ongoing entitlement, and would dominate the count noisily.
  router.get(
    ROUTES.METRICS_PURCHASES_STARTED,
    windowed<PurchaseInfo>(
      'purchases-started',
      () => purchaseStore.listAll(),
      (purchase) => purchase.purchasedAt,
      isNonConsumable,
    ),
  );

  return router;
}

export type { PurchaseInfo, SubscriptionInfo };
