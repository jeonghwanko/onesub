import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { OneSubServerConfig, PurchaseInfo } from '@onesub/shared';
import { PURCHASE_TYPE, ONESUB_ERROR_CODE } from '@onesub/shared';
import type { PurchaseStore } from '../store.js';
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
 */
export function createAdminRouter(
  config: OneSubServerConfig,
  purchaseStore: PurchaseStore,
): Router | null {
  if (!config.adminSecret) return null;

  const router = Router();
  const adminSecret = config.adminSecret;

  // Auth middleware — scoped to /onesub/purchase/admin/* so it doesn't
  // swallow unrelated requests (e.g. host-app routes like /health) when the
  // admin router is mounted at the parent root.
  router.use('/onesub/purchase/admin', (req, res, next) => {
    const provided = req.headers[ADMIN_SECRET_HEADER];
    if (typeof provided !== 'string' || provided !== adminSecret) {
      sendError(res, 401, ONESUB_ERROR_CODE.INVALID_ADMIN_SECRET, 'INVALID_ADMIN_SECRET');
      return;
    }
    next();
  });

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

  return router;
}
