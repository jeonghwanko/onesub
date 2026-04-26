import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type {
  Entitlement,
  EntitlementResponse,
  EntitlementStatus,
  EntitlementsConfig,
  EntitlementsResponse,
  OneSubServerConfig,
  PurchaseInfo,
  SubscriptionInfo,
} from '@onesub/shared';
import { ROUTES, SUBSCRIPTION_STATUS, ONESUB_ERROR_CODE, PURCHASE_TYPE } from '@onesub/shared';
import type { PurchaseStore, SubscriptionStore } from '../store.js';
import { log } from '../logger.js';
import { sendError } from '../errors.js';

/**
 * Evaluate a single entitlement for a user.
 *
 * A user is entitled when EITHER condition holds for any productId in
 * `entitlement.productIds`:
 *   1. an active subscription (status === active|grace_period AND
 *      expiresAt > now) for that productId exists
 *   2. a non-consumable purchase for that productId exists
 *
 * Consumables are intentionally excluded — they grant a one-time resource,
 * not an ongoing right.
 *
 * Subscription is preferred over purchase when both match (subs carry an
 * expiry; non-consumables are forever) so the source field skews toward the
 * more "interesting" signal for ops/analytics.
 */
export async function evaluateEntitlement(
  userId: string,
  entitlement: Entitlement,
  store: SubscriptionStore,
  purchaseStore: PurchaseStore,
): Promise<EntitlementStatus> {
  const productIdSet = new Set(entitlement.productIds);
  const now = Date.now();

  // 1. Check subscriptions first (richer signal — has expiry).
  const subs = await store.getAllByUserId(userId);
  for (const sub of subs) {
    if (!productIdSet.has(sub.productId)) continue;
    const statusAllows =
      sub.status === SUBSCRIPTION_STATUS.ACTIVE ||
      sub.status === SUBSCRIPTION_STATUS.GRACE_PERIOD;
    if (!statusAllows) continue;
    if (new Date(sub.expiresAt).getTime() <= now) continue;
    return {
      active: true,
      source: 'subscription',
      productId: sub.productId,
      expiresAt: sub.expiresAt,
    };
  }

  // 2. Check non-consumable purchases.
  const purchases = await purchaseStore.getPurchasesByUserId(userId);
  for (const p of purchases) {
    if (p.type !== PURCHASE_TYPE.NON_CONSUMABLE) continue;
    if (!productIdSet.has(p.productId)) continue;
    return {
      active: true,
      source: 'purchase',
      productId: p.productId,
    };
  }

  return { active: false, source: null };
}

const userIdSchema = z.string().min(1).max(256);
const entitlementIdSchema = z.string().min(1).max(128);

export function createEntitlementRouter(
  config: OneSubServerConfig,
  store: SubscriptionStore,
  purchaseStore: PurchaseStore,
): Router | null {
  // Only mount when entitlements are configured. Without this guard, the
  // routes would always 503 — better to make the absence loud (404 from
  // express) so misconfiguration is obvious during dev.
  if (!config.entitlements || Object.keys(config.entitlements).length === 0) {
    return null;
  }
  const entitlements: EntitlementsConfig = config.entitlements;

  const router = Router();

  /**
   * GET /onesub/entitlement?userId=&id=premium
   * Single entitlement check.
   */
  router.get(ROUTES.ENTITLEMENT, async (req: Request, res: Response) => {
    let userId: string;
    let id: string;
    try {
      userId = userIdSchema.parse(req.query['userId']);
      id = entitlementIdSchema.parse(req.query['id']);
    } catch {
      sendError(res, 400, ONESUB_ERROR_CODE.INVALID_INPUT, 'userId and id are required');
      return;
    }

    const entitlement = entitlements[id];
    if (!entitlement) {
      sendError(res, 404, ONESUB_ERROR_CODE.ENTITLEMENT_NOT_FOUND, `Unknown entitlement: ${id}`);
      return;
    }

    try {
      const status = await evaluateEntitlement(userId, entitlement, store, purchaseStore);
      const response: EntitlementResponse = { id, ...status };
      res.status(200).json(response);
    } catch (err) {
      log.error('[onesub/entitlement] evaluation error:', err);
      sendError(res, 500, ONESUB_ERROR_CODE.STORE_ERROR, 'Internal server error');
    }
  });

  /**
   * GET /onesub/entitlements?userId=
   * Evaluate every configured entitlement in one round-trip — useful on
   * app launch / login when the host wants the full entitlement map.
   */
  router.get(ROUTES.ENTITLEMENTS, async (req: Request, res: Response) => {
    let userId: string;
    try {
      userId = userIdSchema.parse(req.query['userId']);
    } catch {
      sendError(res, 400, ONESUB_ERROR_CODE.INVALID_INPUT, 'userId is required');
      return;
    }

    try {
      const entries = await Promise.all(
        Object.entries(entitlements).map(async ([id, entitlement]) => {
          const status = await evaluateEntitlement(userId, entitlement, store, purchaseStore);
          return [id, status] as const;
        }),
      );
      const response: EntitlementsResponse = {
        entitlements: Object.fromEntries(entries),
      };
      res.status(200).json(response);
    } catch (err) {
      log.error('[onesub/entitlements] evaluation error:', err);
      sendError(res, 500, ONESUB_ERROR_CODE.STORE_ERROR, 'Internal server error', { entitlements: {} });
    }
  });

  return router;
}

// Keep the unused-type imports honest — these are exported as documentation
// for callers writing their own evaluators.
export type { Entitlement, EntitlementStatus, PurchaseInfo, SubscriptionInfo };
