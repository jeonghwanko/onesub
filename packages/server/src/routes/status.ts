import { Router } from 'express';
import type { Request, Response } from 'express';
import type { StatusResponse } from '@onesub/shared';
import { ROUTES, SUBSCRIPTION_STATUS } from '@onesub/shared';
import type { SubscriptionStore } from '../store.js';

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
      const response: StatusResponse = { active: false, subscription: null };
      res.status(400).json({ ...response, error: 'Missing required query param: userId' });
      return;
    }

    if (userId.length > 256) {
      const response: StatusResponse = { active: false, subscription: null };
      res.status(400).json({ ...response, error: 'userId must not exceed 256 characters' });
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
      console.error('[onesub/status] Store error:', err);
      res.status(500).json({ active: false, subscription: null, error: 'Internal server error' });
    }
  });

  return router;
}
