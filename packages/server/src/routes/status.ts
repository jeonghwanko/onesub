import { Router } from 'express';
import type { Request, Response } from 'express';
import type { StatusResponse } from '@onesub/shared';
import { ROUTES, SUBSCRIPTION_STATUS, ONESUB_ERROR_CODE } from '@onesub/shared';
import type { SubscriptionStore } from '../store.js';
import { log } from '../logger.js';
import { sendError } from '../errors.js';

const NO_SUB = { active: false, subscription: null } as const;

export function createStatusRouter(store: SubscriptionStore): Router {
  const router = Router();

  /**
   * GET /onesub/status?userId=xxx
   *
   * Returns whether the user has an active subscription and the full
   * SubscriptionInfo if one exists.
   */
  router.get(ROUTES.STATUS, async (req: Request, res: Response) => {
    const userId = req.query['userId'];

    if (!userId || typeof userId !== 'string') {
      sendError(res, 400, ONESUB_ERROR_CODE.INVALID_INPUT, 'Missing required query param: userId', NO_SUB);
      return;
    }

    if (userId.length > 256) {
      sendError(res, 400, ONESUB_ERROR_CODE.USER_ID_TOO_LONG, 'userId must not exceed 256 characters', NO_SUB);
      return;
    }

    try {
      const sub = await store.getByUserId(userId);

      if (!sub) {
        const response: StatusResponse = { active: false, subscription: null };
        res.status(200).json(response);
        return;
      }

      const active = sub.status === SUBSCRIPTION_STATUS.ACTIVE;
      const response: StatusResponse = { active, subscription: sub };
      res.status(200).json(response);
    } catch (err) {
      log.error('[onesub/status] Store error:', err);
      sendError(res, 500, ONESUB_ERROR_CODE.STORE_ERROR, 'Internal server error', NO_SUB);
    }
  });

  return router;
}
