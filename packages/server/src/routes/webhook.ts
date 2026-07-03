import { Router } from 'express';
import type { Request, Response } from 'express';
import type { OneSubServerConfig } from '@onesub/shared';
import { ROUTES } from '@onesub/shared';
import type { SubscriptionStore, PurchaseStore } from '../store.js';
import type { WebhookEventStore } from '../webhook-events.js';
import type { WebhookQueue } from '../webhook-queue.js';
import { handleAppleWebhook, processAppleNotification } from './webhook-apple.js';
import type { AppleWebhookWork } from './webhook-apple.js';
import { handleGoogleWebhook, processGoogleNotification } from './webhook-google.js';
import type { GoogleWebhookWork } from './webhook-google.js';

/**
 * Retry / durability semantics.
 *
 * Inline mode (no `webhookQueue`): both Apple and Google retry on any
 * non-2xx response.
 *   4xx — payload is unusable; do NOT retry.
 *   5xx — transient failure; source will retry.
 *   2xx — processed or intentionally ignored.
 *
 * Queue mode (`webhookQueue` configured): the route still owns every 4xx
 * (validation, auth, bundleId/packageName, dedup) inline, but 200s as soon as
 * the decoded work is enqueued. Processing failures are then the QUEUE's
 * retries; exhausted jobs land in the dead-letter list for admin replay.
 */
export function createWebhookRouter(
  config: OneSubServerConfig,
  store: SubscriptionStore,
  purchaseStore: PurchaseStore,
  webhookEventStore?: WebhookEventStore,
  webhookQueue?: WebhookQueue,
): Router {
  // Register the worker handler exactly once, at router creation — it closes
  // over config/stores so job payloads stay JSON-serializable (BullMQ ships
  // them through Redis; live objects would not survive the round-trip).
  if (webhookQueue) {
    webhookQueue.setHandler(async (job) => {
      if (job.provider === 'apple') {
        await processAppleNotification(job.payload as AppleWebhookWork, config, store, purchaseStore);
      } else {
        await processGoogleNotification(job.payload as GoogleWebhookWork, config, store, purchaseStore);
      }
    });
  }

  const router = Router();

  router.post(ROUTES.WEBHOOK_APPLE, (req: Request, res: Response) =>
    handleAppleWebhook(req, res, config, store, purchaseStore, webhookEventStore, webhookQueue),
  );

  router.post(ROUTES.WEBHOOK_GOOGLE, (req: Request, res: Response) =>
    handleGoogleWebhook(req, res, config, store, purchaseStore, webhookEventStore, webhookQueue),
  );

  return router;
}
