import type { Request, Response } from 'express';
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

export async function handleAppleWebhook(
  req: Request,
  res: Response,
  config: OneSubServerConfig,
  store: SubscriptionStore,
  purchaseStore: PurchaseStore,
  webhookEventStore?: WebhookEventStore,
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

  if (webhookEventStore && typeof payload.notificationUUID === 'string') {
    const fresh = await webhookEventStore.markIfNew('apple', payload.notificationUUID);
    if (!fresh) {
      log.info('[onesub/webhook/apple] dedupe: already processed', payload.notificationUUID);
      res.status(200).json({ received: true, deduped: true });
      return;
    }
  }

  const decoded = await decodeAppleNotification(payload, config.apple?.skipJwsVerification);
  if (!decoded) {
    res.status(200).json({ received: true });
    return;
  }

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
  } = decoded;
  const notificationType = payload.notificationType;
  const subtype = payload.subtype;

  // Signature verification proves the notification came from Apple — not that
  // it is for THIS app. Mirror the Google packageName check.
  if (config.apple?.bundleId && bundleId && bundleId !== config.apple.bundleId) {
    log.warn('[onesub/webhook/apple] Bundle ID mismatch:', bundleId, '!==', config.apple.bundleId);
    sendError(res, 400, ONESUB_ERROR_CODE.BUNDLE_ID_MISMATCH, 'Bundle ID mismatch');
    return;
  }

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
    res.status(200).json({ received: true });
    return;
  }

  try {
    if (isOneTimePurchase && isRefundOrRevoke) {
      const lookupId = transactionId ?? originalTransactionId;
      const removed = await purchaseStore.deletePurchaseByTransactionId(lookupId);
      if (!removed) {
        log.warn('[onesub/webhook/apple] IAP refund for unknown transaction:', lookupId);
      }
      res.status(200).json({ received: true });
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

    res.status(200).json({ received: true });
  } catch (err) {
    log.error('[onesub/webhook/apple] Store update error:', err);
    // Un-mark the idempotency key so Apple's retry is processed instead of
    // being deduped — otherwise a transient store failure drops the event forever.
    if (webhookEventStore?.unmark && typeof payload.notificationUUID === 'string') {
      try { await webhookEventStore.unmark('apple', payload.notificationUUID); } catch { /* best-effort */ }
    }
    sendError(res, 500, ONESUB_ERROR_CODE.WEBHOOK_PROCESSING_FAILED, 'Failed to update subscription');
  }
}
