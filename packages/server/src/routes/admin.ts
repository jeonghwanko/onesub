import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type {
  OneSubServerConfig,
  PurchaseInfo,
  ListSubscriptionsResponse,
  Platform,
  SubscriptionStatus,
} from '@onesub/shared';
import { PURCHASE_TYPE, ONESUB_ERROR_CODE, ROUTES, SUBSCRIPTION_STATUS } from '@onesub/shared';
import type { PurchaseStore, SubscriptionStore } from '../store.js';
import { sendError, sendZodError } from '../errors.js';

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
 */
export function createAdminRouter(
  config: OneSubServerConfig,
  purchaseStore: PurchaseStore,
  store: SubscriptionStore,
): Router | null {
  if (!config.adminSecret) return null;

  const router = Router();
  const adminSecret = config.adminSecret;

  // Auth middleware — applied to both admin scopes. Without this guard, a
  // misconfigured mount on the parent root would expose admin endpoints
  // alongside host-app routes (e.g. /health).
  const adminAuth = (req: Request, res: Response, next: () => void) => {
    const provided = req.headers[ADMIN_SECRET_HEADER];
    if (typeof provided !== 'string' || provided !== adminSecret) {
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
    let params;
    try {
      params = resetParamsSchema.parse(req.params);
    } catch {
      sendError(res, 400, ONESUB_ERROR_CODE.INVALID_INPUT, 'userId and productId required');
      return;
    }
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
    let body;
    try {
      body = transferSchema.parse(req.body);
    } catch (err) {
      if (err instanceof z.ZodError) {
        sendZodError(res, err);
        return;
      }
      throw err;
    }
    const existing = await purchaseStore.getPurchaseByTransactionId(body.transactionId);
    if (!existing) {
      sendError(res, 404, ONESUB_ERROR_CODE.TRANSACTION_NOT_FOUND, 'TRANSACTION_NOT_FOUND');
      return;
    }
    // Delete the old row, then save under new userId
    await purchaseStore.deletePurchases(existing.userId, existing.productId);
    const migrated: PurchaseInfo = { ...existing, userId: body.newUserId };
    await purchaseStore.savePurchase(migrated);
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
    let body;
    try {
      body = grantSchema.parse(req.body);
    } catch (err) {
      if (err instanceof z.ZodError) {
        sendZodError(res, err);
        return;
      }
      throw err;
    }

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
    let query: z.infer<typeof listQuerySchema>;
    try {
      query = listQuerySchema.parse(req.query);
    } catch (err) {
      if (err instanceof z.ZodError) {
        sendZodError(res, err);
        return;
      }
      throw err;
    }

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
      sendError(res, 500, ONESUB_ERROR_CODE.STORE_ERROR, (err as Error).message ?? 'list error');
    }
  });

  // GET /onesub/admin/subscriptions/:transactionId — single record by
  // originalTransactionId. Backs the dashboard's subscription detail page.
  const detailParamsSchema = z.object({
    transactionId: z.string().min(1).max(256),
  });
  router.get('/onesub/admin/subscriptions/:transactionId', async (req: Request, res: Response) => {
    let params;
    try {
      params = detailParamsSchema.parse(req.params);
    } catch {
      sendError(res, 400, ONESUB_ERROR_CODE.INVALID_INPUT, 'transactionId required');
      return;
    }
    try {
      const sub = await store.getByTransactionId(params.transactionId);
      if (!sub) {
        sendError(res, 404, ONESUB_ERROR_CODE.TRANSACTION_NOT_FOUND, 'TRANSACTION_NOT_FOUND');
        return;
      }
      res.status(200).json(sub);
    } catch (err) {
      sendError(res, 500, ONESUB_ERROR_CODE.STORE_ERROR, (err as Error).message ?? 'detail error');
    }
  });

  return router;
}
