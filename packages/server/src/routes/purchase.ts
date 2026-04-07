import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type {
  ValidatePurchaseResponse,
  PurchaseStatusResponse,
  PurchaseInfo,
  OneSubServerConfig,
} from '@onesub/shared';
import { ROUTES, PURCHASE_TYPE } from '@onesub/shared';
import type { PurchaseStore } from '../store.js';
import { validateAppleReceipt } from '../providers/apple.js';
import { validateGoogleReceipt } from '../providers/google.js';

const validatePurchaseSchema = z.object({
  platform: z.enum(['apple', 'google']),
  receipt: z.string().min(1).max(10000),
  userId: z.string().min(1).max(256),
  productId: z.string().min(1).max(256),
  type: z.enum([PURCHASE_TYPE.CONSUMABLE, PURCHASE_TYPE.NON_CONSUMABLE]),
});

const purchaseStatusQuerySchema = z.object({
  userId: z.string().min(1).max(256),
  productId: z.string().min(1).max(256).optional(),
});

export function createPurchaseRouter(
  config: OneSubServerConfig,
  purchaseStore: PurchaseStore
): Router {
  const router = Router();

  /**
   * POST /onesub/purchase/validate
   *
   * Validate a receipt for a consumable or non-consumable purchase.
   * - Non-consumables: rejected if the user already owns the product.
   * - Consumables: always recorded (multiple purchases allowed).
   */
  router.post(ROUTES.VALIDATE_PURCHASE, async (req: Request, res: Response) => {
    let body: z.infer<typeof validatePurchaseSchema>;

    try {
      body = validatePurchaseSchema.parse(req.body);
    } catch (err) {
      if (err instanceof z.ZodError) {
        const response: ValidatePurchaseResponse = {
          valid: false,
          purchase: null,
          error: err.issues.map((e: { message: string }) => e.message).join(', '),
        };
        res.status(400).json(response);
        return;
      }
      throw err;
    }

    const { platform, receipt, userId, productId, type } = body;

    try {
      // Non-consumable duplicate check
      if (type === PURCHASE_TYPE.NON_CONSUMABLE) {
        const alreadyOwned = await purchaseStore.hasPurchased(userId, productId);
        if (alreadyOwned) {
          const response: ValidatePurchaseResponse = {
            valid: false,
            purchase: null,
            error: 'NON_CONSUMABLE_ALREADY_OWNED',
          };
          res.status(409).json(response);
          return;
        }
      }

      // Validate receipt via the appropriate provider.
      // Both providers return a SubscriptionInfo-shaped object; we extract only
      // the fields we need for PurchaseInfo (transactionId, purchasedAt).
      let transactionId: string | null = null;
      let purchasedAt: string = new Date().toISOString();

      if (platform === 'apple') {
        if (!config.apple) {
          const response: ValidatePurchaseResponse = {
            valid: false,
            purchase: null,
            error: 'Apple configuration not provided',
          };
          res.status(500).json(response);
          return;
        }
        const sub = await validateAppleReceipt(receipt, config.apple);
        if (sub) {
          transactionId = sub.originalTransactionId;
          purchasedAt = sub.purchasedAt;
        }
      } else {
        if (!config.google) {
          const response: ValidatePurchaseResponse = {
            valid: false,
            purchase: null,
            error: 'Google configuration not provided',
          };
          res.status(500).json(response);
          return;
        }
        const sub = await validateGoogleReceipt(receipt, productId, config.google);
        if (sub) {
          transactionId = sub.originalTransactionId;
          purchasedAt = sub.purchasedAt;
        }
      }

      if (!transactionId) {
        const response: ValidatePurchaseResponse = {
          valid: false,
          purchase: null,
          error: 'Receipt validation failed',
        };
        res.status(422).json(response);
        return;
      }

      // Check for duplicate transaction (idempotency)
      const existing = await purchaseStore.getPurchaseByTransactionId(transactionId);
      if (existing) {
        const response: ValidatePurchaseResponse = {
          valid: true,
          purchase: existing,
        };
        res.status(200).json(response);
        return;
      }

      const purchase: PurchaseInfo = {
        userId,
        productId,
        platform,
        type,
        transactionId,
        purchasedAt,
        quantity: 1,
      };

      await purchaseStore.savePurchase(purchase);

      const response: ValidatePurchaseResponse = {
        valid: true,
        purchase,
      };
      res.status(200).json(response);
    } catch (err) {
      console.error('[onesub/purchase/validate] Unexpected error:', err);
      const response: ValidatePurchaseResponse = {
        valid: false,
        purchase: null,
        error: 'Internal server error during purchase validation',
      };
      res.status(500).json(response);
    }
  });

  /**
   * GET /onesub/purchase/status?userId=xxx[&productId=yyy]
   *
   * Returns all purchases for a user, optionally filtered by productId.
   */
  router.get(ROUTES.PURCHASE_STATUS, async (req: Request, res: Response) => {
    let query: z.infer<typeof purchaseStatusQuerySchema>;

    try {
      query = purchaseStatusQuerySchema.parse(req.query);
    } catch (err) {
      if (err instanceof z.ZodError) {
        res.status(400).json({
          purchases: [],
          error: err.issues.map((e: { message: string }) => e.message).join(', '),
        });
        return;
      }
      throw err;
    }

    const { userId, productId } = query;

    try {
      let purchases = await purchaseStore.getPurchasesByUserId(userId);

      if (productId !== undefined) {
        purchases = purchases.filter((p) => p.productId === productId);
      }

      const response: PurchaseStatusResponse = { purchases };
      res.status(200).json(response);
    } catch (err) {
      console.error('[onesub/purchase/status] Store error:', err);
      res.status(500).json({ purchases: [], error: 'Internal server error' });
    }
  });

  return router;
}
