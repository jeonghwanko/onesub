import type { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import type {
  AppleNotificationPayload,
  OneSubServerConfig,
  SubscriptionInfo,
} from '@onesub/shared';
import { SUBSCRIPTION_STATUS, ONESUB_ERROR_CODE } from '@onesub/shared';
import type { SubscriptionStore, PurchaseStore } from '../store.js';
import {
  decodeAppleNotification,
  decodeJws,
  sendAppleConsumptionResponse,
  fetchAppleSubscriptionStatus,
} from '../providers/apple.js';
import { log } from '../logger.js';
import { sendError } from '../errors.js';
import type { WebhookEventStore } from '../webhook-events.js';
import { unmarkWebhookEvent } from '../webhook-events.js';
import type { WebhookQueue } from '../webhook-queue.js';

const APPLE_ACTIVE_TYPES = new Set(['SUBSCRIBED', 'DID_RENEW', 'DID_RECOVER', 'OFFER_REDEEMED']);
// Granted refunds/revocations only. CONSUMPTION_REQUEST is deliberately NOT
// here: it is Apple *asking for consumption info* while reviewing a refund
// request — the refund may be declined, so revoking entitlement (or deleting
// a purchase row) on it is premature. The actual REFUND/REVOKE notification
// follows if Apple grants it.
const APPLE_CANCELED_TYPES = new Set(['REVOKE', 'REFUND']);
const APPLE_EXPIRED_TYPES = new Set(['EXPIRED']);

function mapAppleNotificationStatus(
  notificationType: string,
  subtype: string | undefined,
): SubscriptionInfo['status'] | null {
  if (notificationType === 'DID_FAIL_TO_RENEW') {
    return subtype === 'GRACE_PERIOD'
      ? SUBSCRIPTION_STATUS.GRACE_PERIOD
      : SUBSCRIPTION_STATUS.ON_HOLD;
  }
  if (notificationType === 'GRACE_PERIOD_EXPIRED') return SUBSCRIPTION_STATUS.ON_HOLD;
  if (APPLE_CANCELED_TYPES.has(notificationType)) return SUBSCRIPTION_STATUS.CANCELED;
  if (APPLE_EXPIRED_TYPES.has(notificationType)) return SUBSCRIPTION_STATUS.EXPIRED;
  if (APPLE_ACTIVE_TYPES.has(notificationType)) return SUBSCRIPTION_STATUS.ACTIVE;
  return null;
}

/** Fully decoded + verified Apple notification transaction data. */
type DecodedAppleNotification = NonNullable<Awaited<ReturnType<typeof decodeAppleNotification>>>;

/**
 * The unit of work handed to the state-mutating processor. Deliberately
 * JSON-serializable (plain strings / booleans / nulls) so it survives a
 * round-trip through a Redis-backed queue (BullMQ) unchanged.
 */
export interface AppleWebhookWork {
  decoded: DecodedAppleNotification;
  notificationType: string;
  subtype?: string;
}

/**
 * State-mutating half of the Apple webhook: everything AFTER the gate
 * (payload validation, JWS verification, idempotency markIfNew, bundleId
 * check) has passed. Called from two places:
 *   - inline by `handleAppleWebhook` when no queue is configured
 *   - by the webhook queue handler (registered in createWebhookRouter)
 * Throws on store failure — the caller decides the retry semantics (source
 * retry via 5xx inline, queue retry + dead-letter in queue mode).
 */
export async function processAppleNotification(
  work: AppleWebhookWork,
  config: OneSubServerConfig,
  store: SubscriptionStore,
  purchaseStore: PurchaseStore,
): Promise<void> {
  const { notificationType, subtype } = work;
  const {
    originalTransactionId,
    transactionId,
    type,
    productId,
    bundleId,
    environment,
    status,
    willRenew,
    expiresAt,
    appAccountToken,
    inAppOwnershipType,
  } = work.decoded;

  const mapped = mapAppleNotificationStatus(notificationType, subtype);
  const finalStatus: SubscriptionInfo['status'] = mapped ?? status;

  if (
    notificationType === 'CONSUMPTION_REQUEST' &&
    config.apple?.consumptionInfoProvider &&
    transactionId &&
    productId
  ) {
    const provider = config.apple.consumptionInfoProvider;
    const appleConfig = config.apple;
    void (async () => {
      try {
        const info = await provider({
          transactionId,
          originalTransactionId,
          productId,
          bundleId: bundleId ?? appleConfig.bundleId,
          environment,
        });
        if (info) {
          await sendAppleConsumptionResponse(transactionId, info, appleConfig, {
            sandbox: environment === 'Sandbox',
          });
        }
      } catch (err) {
        log.warn('[onesub/webhook/apple] consumptionInfoProvider failed:', err);
      }
    })();
  }

  const isOneTimePurchase = type === 'Consumable' || type === 'Non-Consumable';
  const isRefundOrRevoke = APPLE_CANCELED_TYPES.has(notificationType);

  // CONSUMPTION_REQUEST on a one-time purchase is informational — the
  // consumptionInfoProvider hook above is the only work to do. Falling through
  // would run the subscription lookup and a doomed Status API recovery call.
  if (isOneTimePurchase && notificationType === 'CONSUMPTION_REQUEST') {
    return;
  }

  if (isOneTimePurchase && isRefundOrRevoke) {
    const lookupId = transactionId ?? originalTransactionId;
    const removed = await purchaseStore.deletePurchaseByTransactionId(lookupId);
    if (!removed) {
      log.warn('[onesub/webhook/apple] IAP refund for unknown transaction:', lookupId);
    }
    return;
  }

  const existing = await store.getByTransactionId(originalTransactionId);
  if (existing) {
    const isSubscriptionRefund = isRefundOrRevoke && !isOneTimePurchase;
    const keepEntitlement = isSubscriptionRefund && config.refundPolicy === 'until_expiry';

    // If the stored userId was a fallback (originalTransactionId) and we now
    // have a real appAccountToken, correct it. Never overwrite a userId that
    // the client set explicitly (which would differ from originalTransactionId).
    const correctedUserId =
      appAccountToken && existing.userId === originalTransactionId
        ? appAccountToken
        : existing.userId;
    if (correctedUserId !== existing.userId) {
      log.info('[onesub/webhook/apple] correcting userId from originalTransactionId to appAccountToken:', correctedUserId);
    }

    const updated: SubscriptionInfo = keepEntitlement
      ? { ...existing, userId: correctedUserId, willRenew: false }
      : {
          ...existing,
          userId: correctedUserId,
          status: finalStatus,
          willRenew,
          expiresAt: expiresAt ?? existing.expiresAt,
        };
    await store.save(updated);
  } else if (config.apple?.issuerId && config.apple?.keyId && config.apple?.privateKey) {
    const fresh = await fetchAppleSubscriptionStatus(originalTransactionId, config.apple, {
      sandbox: environment === 'Sandbox',
    });
    if (fresh) {
      fresh.userId = appAccountToken ?? originalTransactionId;
      if (inAppOwnershipType === 'FAMILY_SHARED') {
        const source = appAccountToken ? 'appAccountToken' : 'originalTransactionId (fallback)';
        log.info(`[onesub/webhook/apple] FAMILY_SHARED — userId: ${fresh.userId} (source: ${source})`);
      }
      await store.save(fresh);
    } else {
      log.warn(
        '[onesub/webhook/apple] Unknown transaction and Status API returned no record:',
        originalTransactionId,
      );
    }
  } else {
    log.warn(
      '[onesub/webhook/apple] Received notification for unknown transaction (no API creds to recover):',
      originalTransactionId,
    );
  }
}

export async function handleAppleWebhook(
  req: Request,
  res: Response,
  config: OneSubServerConfig,
  store: SubscriptionStore,
  purchaseStore: PurchaseStore,
  webhookEventStore?: WebhookEventStore,
  webhookQueue?: WebhookQueue,
): Promise<void> {
  const body = req.body as { signedPayload?: string };

  if (!body.signedPayload) {
    sendError(res, 400, ONESUB_ERROR_CODE.MISSING_SIGNED_PAYLOAD, 'Missing signedPayload');
    return;
  }

  let payload: AppleNotificationPayload;
  try {
    payload = await decodeJws<AppleNotificationPayload>(
      body.signedPayload,
      config.apple?.skipJwsVerification,
    );
  } catch (err) {
    log.error('[onesub/webhook/apple] Failed to decode signedPayload:', err);
    sendError(res, 400, ONESUB_ERROR_CODE.INVALID_SIGNED_PAYLOAD, 'Invalid signedPayload');
    return;
  }

  // Idempotency gate. Runs BEFORE any enqueue, so in queue mode duplicate
  // deliveries never produce a second job (complemented by the queue-level
  // jobId dedup below). Capture the marked id once here — it is the only id
  // `unmarkWebhookEvent` may ever release.
  let markedEventId: string | undefined;
  if (webhookEventStore && typeof payload.notificationUUID === 'string') {
    const fresh = await webhookEventStore.markIfNew('apple', payload.notificationUUID);
    if (!fresh) {
      log.info('[onesub/webhook/apple] dedupe: already processed', payload.notificationUUID);
      res.status(200).json({ received: true, deduped: true });
      return;
    }
    markedEventId = payload.notificationUUID;
  }

  const decoded = await decodeAppleNotification(payload, config.apple?.skipJwsVerification);
  if (!decoded) {
    res.status(200).json({ received: true });
    return;
  }

  // Signature verification proves the notification came from Apple — not that
  // it is for THIS app. Mirror the Google packageName check.
  if (config.apple?.bundleId && decoded.bundleId && decoded.bundleId !== config.apple.bundleId) {
    log.warn('[onesub/webhook/apple] Bundle ID mismatch:', decoded.bundleId, '!==', config.apple.bundleId);
    sendError(res, 400, ONESUB_ERROR_CODE.BUNDLE_ID_MISMATCH, 'Bundle ID mismatch');
    return;
  }

  const work: AppleWebhookWork = {
    decoded,
    notificationType: payload.notificationType,
    subtype: payload.subtype,
  };

  if (webhookQueue) {
    // Queue mode: the cheap gating above ran inline; the state-mutating
    // processing runs in the queue handler. Ack as soon as the job is
    // durably accepted.
    //
    // Idempotency tradeoff: once enqueued, transient handler failures are the
    // QUEUE's retries (backoff + dead-letter), not the source's — so the
    // event stays marked even if the job ultimately fails. After max attempts
    // the job lands in the dead-letter list; admin replay
    // (POST /onesub/admin/webhook-replay/:id) is the recovery path. Unmarking
    // here would let a source retry race the queue's retries and double-apply.
    try {
      await webhookQueue.enqueue<AppleWebhookWork>({
        provider: 'apple',
        // Stable job id feeds queue-level dedup (BullMQ jobId). Random
        // fallback when Apple omits the UUID — no dedup possible anyway.
        eventId: typeof payload.notificationUUID === 'string' ? payload.notificationUUID : randomUUID(),
        payload: work,
      });
      res.status(200).json({ received: true, queued: true });
    } catch (err) {
      // Enqueue itself failed (e.g. Redis down) — the job was never durably
      // accepted, so the queue can't retry it. Fall back to source-retry
      // semantics: unmark + 5xx so Apple redelivers.
      log.error('[onesub/webhook/apple] Failed to enqueue webhook job:', err);
      await unmarkWebhookEvent(webhookEventStore, 'apple', markedEventId);
      sendError(res, 500, ONESUB_ERROR_CODE.WEBHOOK_PROCESSING_FAILED, 'Failed to update subscription');
    }
    return;
  }

  // Inline mode (no queue configured): process synchronously inside the
  // request. On failure, un-mark the idempotency key so Apple's retry is
  // processed instead of being deduped — otherwise a transient store failure
  // drops the event forever.
  try {
    await processAppleNotification(work, config, store, purchaseStore);
    res.status(200).json({ received: true });
  } catch (err) {
    log.error('[onesub/webhook/apple] Store update error:', err);
    await unmarkWebhookEvent(webhookEventStore, 'apple', markedEventId);
    sendError(res, 500, ONESUB_ERROR_CODE.WEBHOOK_PROCESSING_FAILED, 'Failed to update subscription');
  }
}
