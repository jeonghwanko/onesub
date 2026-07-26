import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { OneSubServerConfig } from '@onesub/shared';
import { ONESUB_ERROR_CODE } from '@onesub/shared';
import { signApplePromotionalOffer } from '../providers/apple.js';
import { sendError, parseOrSend } from '../errors.js';
import { secretsEqual } from './secret-compare.js';
import { log } from '../logger.js';

const OFFER_SECRET_HEADER = 'x-onesub-offer-secret';

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
 * Authentication: if config.adminSecret is set, the request must carry
 * `X-Onesub-Offer-Secret: <adminSecret>` (same value). Hosts that mount
 * onesub without adminSecret are responsible for securing this endpoint
 * themselves (e.g. behind their own auth middleware).
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
    if (config.adminSecret) {
      const provided = req.headers[OFFER_SECRET_HEADER];
      if (typeof provided !== 'string' || !secretsEqual(provided, config.adminSecret)) {
        sendError(res, 401, ONESUB_ERROR_CODE.UNAUTHORIZED, 'Unauthorized');
        return;
      }
    }
    const body = parseOrSend(res, offerBodySchema, req.body);
    if (!body) return;

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
      // The message is deliberately generic: this route signs with the
      // promotional-offer private key, so a crypto/JOSE failure message is the
      // last thing to hand an unauthenticated-until-proven caller.
      log.error('[onesub/apple/offer] signing error:', err);
      sendError(res, 500, ONESUB_ERROR_CODE.INTERNAL_ERROR, 'Offer signing failed');
    }
  });

  return router;
}
