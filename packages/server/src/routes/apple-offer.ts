import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { OneSubServerConfig } from '@onesub/shared';
import { ONESUB_ERROR_CODE } from '@onesub/shared';
import { signApplePromotionalOffer } from '../providers/apple.js';
import { sendError, sendZodError } from '../errors.js';

const offerBodySchema = z.object({
  productId: z.string().min(1).max(256),
  offerId: z.string().min(1).max(256),
  applicationUsername: z.string().min(1).max(256),
});

/**
 * POST /onesub/apple/offer-signature
 *
 * Sign an Apple Promotional Offer payload server-side.
 * Requires config.apple.offerKeyId and config.apple.offerPrivateKey.
 *
 * Body: { productId, offerId, applicationUsername }
 * Response: { keyId, nonce, timestamp, signature }
 *
 * The client passes these four values to StoreKit's
 * Product.SubscriptionOffer.Signature to redeem the offer.
 */
export function createAppleOfferRouter(config: OneSubServerConfig): Router | null {
  const apple = config.apple as (OneSubServerConfig['apple'] & { offerKeyId?: string; offerPrivateKey?: string }) | undefined;
  if (!apple?.offerKeyId || !apple?.offerPrivateKey) return null;

  const router = Router();

  router.post('/onesub/apple/offer-signature', async (req: Request, res: Response) => {
    let body: z.infer<typeof offerBodySchema>;
    try {
      body = offerBodySchema.parse(req.body);
    } catch (err) {
      if (err instanceof z.ZodError) {
        sendZodError(res, err);
        return;
      }
      throw err;
    }

    if (!apple.bundleId) {
      sendError(res, 400, ONESUB_ERROR_CODE.APPLE_CONFIG_MISSING, 'config.apple.bundleId is required for offer signing');
      return;
    }

    try {
      const result = await signApplePromotionalOffer(
        {
          bundleId: apple.bundleId,
          productId: body.productId,
          offerId: body.offerId,
          applicationUsername: body.applicationUsername,
        },
        apple,
      );
      res.status(200).json(result);
    } catch (err) {
      sendError(res, 500, ONESUB_ERROR_CODE.INTERNAL_ERROR, (err as Error).message ?? 'Offer signing failed');
    }
  });

  return router;
}
