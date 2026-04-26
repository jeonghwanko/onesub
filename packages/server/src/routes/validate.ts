import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { ValidateReceiptResponse, OneSubServerConfig } from '@onesub/shared';
import { ROUTES, ONESUB_ERROR_CODE } from '@onesub/shared';
import type { SubscriptionStore } from '../store.js';
import { validateAppleReceipt } from '../providers/apple.js';
import { validateGoogleReceipt, acknowledgeGoogleSubscription } from '../providers/google.js';
import { log } from '../logger.js';
import { sendError, sendZodError } from '../errors.js';

const NO_SUB = { valid: false, subscription: null } as const;

const validateSchema = z.object({
  platform: z.enum(['apple', 'google']),
  receipt: z.string().min(1).max(10000),
  userId: z.string().min(1).max(256),
  productId: z.string().min(1).max(256),
});

export function createValidateRouter(
  config: OneSubServerConfig,
  store: SubscriptionStore
): Router {
  const router = Router();

  router.post(ROUTES.VALIDATE, async (req: Request, res: Response) => {
    let platform: string;
    let receipt: string;
    let userId: string;
    let productId: string;

    try {
      ({ platform, receipt, userId, productId } = validateSchema.parse(req.body));
    } catch (err) {
      if (err instanceof z.ZodError) {
        sendZodError(res, err, NO_SUB);
        return;
      }
      throw err;
    }

    try {
      let sub = null;

      if (platform === 'apple') {
        if (!config.apple) {
          sendError(res, 500, ONESUB_ERROR_CODE.APPLE_CONFIG_MISSING, 'Apple configuration not provided', NO_SUB);
          return;
        }
        sub = await validateAppleReceipt(receipt, config.apple);
      } else {
        if (!config.google) {
          sendError(res, 500, ONESUB_ERROR_CODE.GOOGLE_CONFIG_MISSING, 'Google configuration not provided', NO_SUB);
          return;
        }
        sub = await validateGoogleReceipt(receipt, productId, config.google);
      }

      if (!sub) {
        sendError(res, 422, ONESUB_ERROR_CODE.RECEIPT_VALIDATION_FAILED, 'Receipt validation failed', NO_SUB);
        return;
      }

      sub.userId = userId;
      await store.save(sub);

      // Google requires acknowledgement within 3 days of purchase or the
      // transaction is auto-refunded. Fire-and-forget — entitlement is already
      // saved, ack is idempotent on the Play side.
      if (platform === 'google' && config.google) {
        void acknowledgeGoogleSubscription(receipt, productId, config.google);
      }

      const response: ValidateReceiptResponse = { valid: true, subscription: sub };
      res.status(200).json(response);
    } catch (err) {
      log.error('[onesub/validate] Unexpected error:', err);
      sendError(res, 500, ONESUB_ERROR_CODE.INTERNAL_ERROR, 'Internal server error during receipt validation', NO_SUB);
    }
  });

  return router;
}
