import { Router } from 'express';
import type { Request, Response } from 'express';
import type { ValidateReceiptRequest, ValidateReceiptResponse, OneSubServerConfig } from '@onesub/shared';
import { ROUTES } from '@onesub/shared';
import type { SubscriptionStore } from '../store.js';
import { validateAppleReceipt } from '../providers/apple.js';
import { validateGoogleReceipt } from '../providers/google.js';

export function createValidateRouter(
  config: OneSubServerConfig,
  store: SubscriptionStore
): Router {
  const router = Router();

  router.post(ROUTES.VALIDATE, async (req: Request, res: Response) => {
    const body = req.body as Partial<ValidateReceiptRequest>;

    const { platform, receipt, userId, productId } = body;

    if (!platform || !receipt || !userId || !productId) {
      const response: ValidateReceiptResponse = {
        valid: false,
        subscription: null,
        error: 'Missing required fields: platform, receipt, userId, productId',
      };
      res.status(400).json(response);
      return;
    }

    if (platform !== 'apple' && platform !== 'google') {
      const response: ValidateReceiptResponse = {
        valid: false,
        subscription: null,
        error: 'platform must be "apple" or "google"',
      };
      res.status(400).json(response);
      return;
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
      console.error('[onesub/validate] Unexpected error:', err);
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
