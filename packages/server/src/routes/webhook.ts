import { Router } from 'express';
import type { Request, Response } from 'express';
import type { OneSubServerConfig } from '@onesub/shared';
import { ROUTES } from '@onesub/shared';
import type { SubscriptionStore, PurchaseStore } from '../store.js';
import type { WebhookEventStore } from '../webhook-events.js';
import { handleAppleWebhook } from './webhook-apple.js';
import { handleGoogleWebhook } from './webhook-google.js';

/**
 * Retry / durability semantics.
 *
 * Both Apple and Google retry on any non-2xx response.
 *   4xx — payload is unusable; do NOT retry.
 *   5xx — transient failure; source will retry.
 *   2xx — processed or intentionally ignored.
 */
export function createWebhookRouter(
  config: OneSubServerConfig,
  store: SubscriptionStore,
  purchaseStore: PurchaseStore,
  webhookEventStore?: WebhookEventStore,
): Router {
  const router = Router();

  router.post(ROUTES.WEBHOOK_APPLE, (req: Request, res: Response) =>
    handleAppleWebhook(req, res, config, store, purchaseStore, webhookEventStore),
  );

  router.post(ROUTES.WEBHOOK_GOOGLE, (req: Request, res: Response) =>
    handleGoogleWebhook(req, res, config, store, purchaseStore, webhookEventStore),
  );

  return router;
}
