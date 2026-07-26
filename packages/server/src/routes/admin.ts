import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type {
  CustomerProfileResponse,
  EntitlementStatus,
  OneSubServerConfig,
  PurchaseInfo,
  ListSubscriptionsResponse,
  Platform,
  SubscriptionStatus,
} from '@onesub/shared';
import { PURCHASE_TYPE, ONESUB_ERROR_CODE, ROUTES, SUBSCRIPTION_STATUS } from '@onesub/shared';
import type { PurchaseStore, SubscriptionStore } from '../store.js';
import { evaluateEntitlementFrom } from './entitlements.js';
import { sendError, parseOrSend } from '../errors.js';
import type { WebhookQueue } from '../webhook-queue.js';
import { fetchAppleSubscriptionStatus } from '../providers/apple.js';
import { secretsEqual } from './secret-compare.js';
import { setTestOverride, clearTestOverride, listTestOverrides } from '../test-overrides.js';
import { log } from '../logger.js';

const ADMIN_SECRET_HEADER = 'x-admin-secret';

/**
 * Admin routes for testing / operational tasks. Require `X-Admin-Secret`
 * header matching config.adminSecret. If config.adminSecret is not set, the
 * entire admin router is not mounted (returns 404 from the parent router).
 *
 * Endpoints:
 *   DELETE /onesub/purchase/admin/:userId/:productId
 *     → reset a non-consumable so the user can test the purchase flow again
 *
 *   POST /onesub/purchase/admin/grant
 *     → manually insert a purchase record (skips store verification)
 *     body: { userId, productId, platform, type?, transactionId? }
 *
 *   POST /onesub/purchase/admin/transfer
 *     → reassign a transactionId to a new userId (device migration)
 *
 *   GET /onesub/admin/subscriptions?userId=&status=&productId=&platform=&limit=&offset=
 *     → filtered/paginated subscription list (used by dashboard + scripts)
 *
 *   GET /onesub/admin/subscriptions/:transactionId
 *     → single subscription record by originalTransactionId (dashboard detail page)
 *
 *   GET /onesub/admin/customers/:userId
 *     → bundle of every record onesub knows for one user (subs + purchases +
 *       entitlements when configured). Backs the dashboard customer detail page.
 */
export function createAdminRouter(
  config: OneSubServerConfig,
  purchaseStore: PurchaseStore,
  store: SubscriptionStore,
  webhookQueue?: WebhookQueue,
): Router | null {
  if (!config.adminSecret) return null;

  const router = Router();
  const adminSecret = config.adminSecret;

  // Auth middleware — applied to both admin scopes. Without this guard, a
  // misconfigured mount on the parent root would expose admin endpoints
  // alongside host-app routes (e.g. /health).
  const adminAuth = (req: Request, res: Response, next: () => void) => {
    const provided = req.headers[ADMIN_SECRET_HEADER];
    if (typeof provided !== 'string' || !secretsEqual(provided, adminSecret)) {
      sendError(res, 401, ONESUB_ERROR_CODE.INVALID_ADMIN_SECRET, 'INVALID_ADMIN_SECRET');
      return;
    }
    next();
  };
  router.use('/onesub/purchase/admin', adminAuth);
  router.use('/onesub/admin', adminAuth);

  // DELETE /onesub/purchase/admin/:userId/:productId
  // Express 5 types route params as `string | string[]` — narrow via zod.
  const resetParamsSchema = z.object({
    userId: z.string().min(1).max(256),
    productId: z.string().min(1).max(256),
  });
  router.delete('/onesub/purchase/admin/:userId/:productId', async (req: Request, res: Response) => {
    const params = parseOrSend(res, resetParamsSchema, req.params, {
      message: 'userId and productId required',
    });
    if (!params) return;
    const deleted = await purchaseStore.deletePurchases(params.userId, params.productId);
    res.json({ ok: true, deleted });
  });

  // POST /onesub/purchase/admin/transfer — reassign transactionId to a new userId
  // (legitimate device/account migration)
  const transferSchema = z.object({
    transactionId: z.string().min(1).max(256),
    newUserId: z.string().min(1).max(256),
  });
  router.post('/onesub/purchase/admin/transfer', async (req: Request, res: Response) => {
    const body = parseOrSend(res, transferSchema, req.body);
    if (!body) return;
    const existing = await purchaseStore.getPurchaseByTransactionId(body.transactionId);
    if (!existing) {
      sendError(res, 404, ONESUB_ERROR_CODE.TRANSACTION_NOT_FOUND, 'TRANSACTION_NOT_FOUND');
      return;
    }
    // Move only this transaction. deletePurchases(userId, productId) would
    // also destroy sibling consumable rows for the same product.
    const moved = await purchaseStore.reassignPurchase(body.transactionId, body.newUserId);
    if (!moved) {
      // Row vanished between the lookup above and the reassign (e.g. a
      // concurrent refund webhook deleted it) — don't report a false success.
      sendError(res, 404, ONESUB_ERROR_CODE.TRANSACTION_NOT_FOUND, 'TRANSACTION_NOT_FOUND');
      return;
    }
    const migrated: PurchaseInfo = { ...existing, userId: body.newUserId };
    res.json({ ok: true, purchase: migrated });
  });

  // POST /onesub/purchase/admin/grant
  const grantSchema = z.object({
    userId: z.string().min(1).max(256),
    productId: z.string().min(1).max(256),
    platform: z.enum(['apple', 'google']),
    type: z.enum([PURCHASE_TYPE.CONSUMABLE, PURCHASE_TYPE.NON_CONSUMABLE]).default(PURCHASE_TYPE.NON_CONSUMABLE),
    transactionId: z.string().min(1).max(256).optional(),
  });

  router.post('/onesub/purchase/admin/grant', async (req: Request, res: Response) => {
    const body = parseOrSend(res, grantSchema, req.body);
    if (!body) return;

    const transactionId = body.transactionId ?? `admin_grant_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    const purchase: PurchaseInfo = {
      transactionId,
      userId: body.userId,
      productId: body.productId,
      platform: body.platform,
      type: body.type,
      quantity: 1,
      purchasedAt: new Date().toISOString(),
    };
    await purchaseStore.savePurchase(purchase);
    res.json({ ok: true, purchase });
  });

  // GET /onesub/admin/subscriptions?userId=&status=&productId=&platform=&limit=&offset=
  // Filtered + paginated subscription list. Backs the dashboard's
  // subscriptions page and ad-hoc operational scripts.
  const listQuerySchema = z.object({
    userId: z.string().min(1).max(256).optional(),
    status: z.enum([
      SUBSCRIPTION_STATUS.ACTIVE,
      SUBSCRIPTION_STATUS.GRACE_PERIOD,
      SUBSCRIPTION_STATUS.ON_HOLD,
      SUBSCRIPTION_STATUS.PAUSED,
      SUBSCRIPTION_STATUS.EXPIRED,
      SUBSCRIPTION_STATUS.CANCELED,
      SUBSCRIPTION_STATUS.NONE,
    ] as [SubscriptionStatus, ...SubscriptionStatus[]]).optional(),
    productId: z.string().min(1).max(256).optional(),
    platform: z.enum(['apple', 'google'] as [Platform, ...Platform[]]).optional(),
    // Cap at 200 server-side so a runaway dashboard query can't tip the DB.
    limit: z.coerce.number().int().positive().max(200).optional(),
    offset: z.coerce.number().int().nonnegative().optional(),
  });

  router.get(ROUTES.ADMIN_SUBSCRIPTIONS, async (req: Request, res: Response) => {
    const query = parseOrSend(res, listQuerySchema, req.query);
    if (!query) return;

    try {
      const result = await store.listFiltered(query);
      const response: ListSubscriptionsResponse = {
        items: result.items,
        total: result.total,
        limit: result.limit,
        offset: result.offset,
      };
      res.status(200).json(response);
    } catch (err) {
      // Bubble the message up but not the stack — admin clients log status code
      log.error('[onesub/admin/subscriptions] list error:', err);
      sendError(res, 500, ONESUB_ERROR_CODE.STORE_ERROR, 'Internal server error');
    }
  });

  // GET /onesub/admin/subscriptions/:transactionId — single record by
  // originalTransactionId. Backs the dashboard's subscription detail page.
  const detailParamsSchema = z.object({
    transactionId: z.string().min(1).max(256),
  });
  router.get('/onesub/admin/subscriptions/:transactionId', async (req: Request, res: Response) => {
    const params = parseOrSend(res, detailParamsSchema, req.params, {
      message: 'transactionId required',
    });
    if (!params) return;
    try {
      const sub = await store.getByTransactionId(params.transactionId);
      if (!sub) {
        sendError(res, 404, ONESUB_ERROR_CODE.TRANSACTION_NOT_FOUND, 'TRANSACTION_NOT_FOUND');
        return;
      }
      res.status(200).json(sub);
    } catch (err) {
      log.error('[onesub/admin/subscriptions/:transactionId] detail error:', err);
      sendError(res, 500, ONESUB_ERROR_CODE.STORE_ERROR, 'Internal server error');
    }
  });

  // GET /onesub/admin/customers/:userId — full per-user profile. Combines the
  // store calls a CS dashboard makes for "show me everything about this user"
  // into a single round-trip.
  //
  // Always returns 200 (even for unknown userIds) — empty arrays + no
  // entitlements means "we have no record of this user", which is a valid
  // signal for the dashboard to render rather than an error condition.
  const customerParamsSchema = z.object({
    userId: z.string().min(1).max(256),
  });
  router.get('/onesub/admin/customers/:userId', async (req: Request, res: Response) => {
    const params = parseOrSend(res, customerParamsSchema, req.params, {
      message: 'userId required',
    });
    if (!params) return;
    try {
      const [subscriptions, purchases] = await Promise.all([
        store.getAllByUserId(params.userId),
        purchaseStore.getPurchasesByUserId(params.userId),
      ]);

      // Evaluate entitlements only when configured. Hosts that don't use the
      // entitlement abstraction get the field omitted (dashboard hides panel).
      //
      // Reuses the records fetched above — `evaluateEntitlement` would re-read
      // both stores for every entitlement, so a host with N entitlements paid
      // 2N extra round-trips, serially, on every customer page load.
      let entitlements: Record<string, EntitlementStatus> | undefined;
      if (config.entitlements && Object.keys(config.entitlements).length > 0) {
        const now = Date.now();
        entitlements = {};
        for (const [id, def] of Object.entries(config.entitlements)) {
          entitlements[id] = evaluateEntitlementFrom(subscriptions, purchases, def, now);
        }
      }

      const response: CustomerProfileResponse = {
        userId: params.userId,
        subscriptions,
        purchases,
        ...(entitlements ? { entitlements } : {}),
      };
      res.status(200).json(response);
    } catch (err) {
      log.error('[onesub/admin/customers/:userId] error:', err);
      sendError(res, 500, ONESUB_ERROR_CODE.STORE_ERROR, 'Internal server error');
    }
  });

  // POST /onesub/admin/sync-apple/:originalTransactionId
  // Fetch the current subscription state directly from Apple's Status API and
  // upsert into the local store. Useful for reconciliation / missed-webhook recovery.
  const syncAppleParamsSchema = z.object({
    originalTransactionId: z.string().min(1).max(256),
  });
  router.post(ROUTES.ADMIN_SYNC_APPLE, async (req: Request, res: Response) => {
    const params = parseOrSend(res, syncAppleParamsSchema, req.params, {
      message: 'originalTransactionId required',
    });
    if (!params) return;

    if (!config.apple?.issuerId || !config.apple?.keyId || !config.apple?.privateKey) {
      sendError(res, 400, ONESUB_ERROR_CODE.APPLE_CONFIG_MISSING, 'Apple API credentials not configured');
      return;
    }

    try {
      const { originalTransactionId } = params;
      // Allow callers to force sandbox mode; otherwise infer from the stored record.
      const existingForEnv = await store.getByTransactionId(originalTransactionId);
      const isSandbox =
        req.query['sandbox'] === 'true' ||
        (existingForEnv as (typeof existingForEnv & { environment?: string }) | null)?.environment === 'Sandbox';
      const fresh = await fetchAppleSubscriptionStatus(originalTransactionId, config.apple, { sandbox: isSandbox });
      if (!fresh) {
        sendError(res, 404, ONESUB_ERROR_CODE.TRANSACTION_NOT_FOUND, 'Apple Status API returned no record');
        return;
      }

      const existing = existingForEnv;
      fresh.userId = existing?.userId ?? originalTransactionId;
      await store.save(fresh);
      res.status(200).json({ ok: true, subscription: fresh });
    } catch (err) {
      log.error('[onesub/admin/sync-apple] error:', err);
      sendError(res, 500, ONESUB_ERROR_CODE.INTERNAL_ERROR, 'Internal server error');
    }
  });

  // ── Sandbox-only entitlement overrides (manual testing) ──
  // Apple cannot cancel a sandbox subscription bought with a real Apple Account,
  // so a tester who subscribes once stays entitled and can never re-run the
  // purchase flow. These force "not entitled" for one userId, and are honoured
  // only when the receipt being validated is a Sandbox one. See test-overrides.ts.
  const overrideParamsSchema = z.object({ userId: z.string().min(1).max(256) });
  const overrideBodySchema = z.object({ entitled: z.boolean() });

  router.get(ROUTES.ADMIN_TEST_OVERRIDES, (_req: Request, res: Response) => {
    res.json({ overrides: listTestOverrides() });
  });

  router.put(ROUTES.ADMIN_TEST_OVERRIDE, (req: Request, res: Response) => {
    const params = parseOrSend(res, overrideParamsSchema, req.params);
    if (!params) return;
    const body = parseOrSend(res, overrideBodySchema, req.body);
    if (!body) return;
    setTestOverride(params.userId, body.entitled);
    log.warn(
      `[onesub/admin] sandbox test override set for ${params.userId}: entitled=${body.entitled}`,
    );
    res.json({ ok: true, userId: params.userId, entitled: body.entitled, sandboxOnly: true });
  });

  router.delete(ROUTES.ADMIN_TEST_OVERRIDE, (req: Request, res: Response) => {
    const params = parseOrSend(res, overrideParamsSchema, req.params, {
      message: 'userId required',
    });
    if (!params) return;
    const cleared = clearTestOverride(params.userId);
    res.json({ ok: true, userId: params.userId, cleared });
  });

  // GET /onesub/admin/webhook-deadletters
  // POST /onesub/admin/webhook-replay/:id
  // Only mounted when the configured queue supports dead-letter inspection
  // (the default in-process queue does not — Apple/Google retries are the
  // durability layer for that mode).
  if (webhookQueue?.listDeadLetters) {
    router.get('/onesub/admin/webhook-deadletters', async (_req: Request, res: Response) => {
      try {
        const items = await webhookQueue.listDeadLetters!();
        res.status(200).json({ items });
      } catch (err) {
        log.error('[onesub/admin/webhook-deadletters] error:', err);
        sendError(res, 500, ONESUB_ERROR_CODE.STORE_ERROR, 'Internal server error');
      }
    });
  }

  if (webhookQueue?.replayDeadLetter) {
    const replayParamsSchema = z.object({ id: z.string().min(1).max(256) });
    router.post('/onesub/admin/webhook-replay/:id', async (req: Request, res: Response) => {
      const params = parseOrSend(res, replayParamsSchema, req.params, { message: 'id required' });
      if (!params) return;
      try {
        await webhookQueue.replayDeadLetter!(params.id);
        res.status(200).json({ ok: true });
      } catch (err) {
        log.error('[onesub/admin/webhook-replay] error:', err);
        sendError(res, 500, ONESUB_ERROR_CODE.STORE_ERROR, 'Internal server error');
      }
    });
  }

  return router;
}
