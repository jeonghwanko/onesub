import { Router } from 'express';
import type { Request, Response } from 'express';
import type { StatusResponse } from '@onesub/shared';
import { ROUTES, ONESUB_ERROR_CODE, isSubscriptionEntitled } from '@onesub/shared';
import type { SubscriptionStore } from '../store.js';
import { log } from '../logger.js';
import { sendError } from '../errors.js';
import { withoutReplaced } from '../lifecycle.js';

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
      // Every record, not just the most recently written: a webhook touching
      // an old, expired subscription makes it the newest row, and reading only
      // that one hid a still-active subscription for another product.
      const subs = await store.getAllByUserId(userId);
      if (subs.length === 0) {
        const response: StatusResponse = { active: false, subscription: null };
        res.status(200).json(response);
        return;
      }

      // Report the most recent subscription that grants access, else the most
      // recent one. The `active` rule (entitled status AND unexpired) lives in
      // isSubscriptionEntitled — see packages/shared/README.md.
      const now = Date.now();
      const entitled = withoutReplaced(subs).find((s) => isSubscriptionEntitled(s, now));
      const sub = entitled ?? subs[0]!;
      const active = entitled !== undefined;
      const response: StatusResponse = { active, subscription: sub };
      res.status(200).json(response);
    } catch (err) {
      log.error('[onesub/status] Store error', { userId, err });
      sendError(res, 500, ONESUB_ERROR_CODE.STORE_ERROR, 'Internal server error', NO_SUB);
    }
  });

  return router;
}
