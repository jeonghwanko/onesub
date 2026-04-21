import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { ValidateReceiptResponse, OneSubServerConfig } from '@onesub/shared';
import { ROUTES } from '@onesub/shared';
import type { SubscriptionStore } from '../store.js';
import { validateAppleReceipt } from '../providers/apple.js';
import { validateGoogleReceipt } from '../providers/google.js';
import { log } from '../logger.js';

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
        const response: ValidateReceiptResponse = {
          valid: false,
          subscription: null,
          error: err.issues.map((e: { message: string }) => e.message).join(', '),
        };
        res.status(400).json(response);
        return;
      }
      throw err;
    }

    try {
      let sub = null;

      if (platform === 'apple') {
        if (!config.apple) {
          const response: ValidateReceiptResponse = {
            valid: false,
            subscription: null,
            error: 'Apple configuration not provided',
          };
          res.status(500).json(response);
          return;
        }
        sub = await validateAppleReceipt(receipt, config.apple);
      } else {
        if (!config.google) {
          const response: ValidateReceiptResponse = {
            valid: false,
            subscription: null,
            error: 'Google configuration not provided',
          };
          res.status(500).json(response);
          return;
        }
        sub = await validateGoogleReceipt(receipt, productId, config.google);
      }

      if (!sub) {
        const response: ValidateReceiptResponse = {
          valid: false,
          subscription: null,
          error: 'Receipt validation failed',
        };
        res.status(422).json(response);
        return;
      }

      // Attach the userId from the request
      sub.userId = userId;

      // Persist to the store
      await store.save(sub);

      const response: ValidateReceiptResponse = {
        valid: true,
        subscription: sub,
      };
      res.status(200).json(response);
    } catch (err) {
      log.error('[onesub/validate] Unexpected error:', err);
      const response: ValidateReceiptResponse = {
        valid: false,
        subscription: null,
        error: 'Internal server error during receipt validation',
      };
      res.status(500).json(response);
    }
  });

  return router;
}
