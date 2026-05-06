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
const APPLE_CANCELED_TYPES = new Set(['REVOKE', 'REFUND', 'CONSUMPTION_REQUEST']);
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
      const isSubscriptionRefund =
        isRefundOrRevoke && !isOneTimePurchase && notificationType !== 'CONSUMPTION_REQUEST';
      const keepEntitlement = isSubscriptionRefund && config.refundPolicy === 'until_expiry';

      const updated: SubscriptionInfo = keepEntitlement
        ? { ...existing, willRenew: false }
        : {
            ...existing,
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
          log.info('[onesub/webhook/apple] FAMILY_SHARED transaction — userId derived from appAccountToken:', fresh.userId);
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
    sendError(res, 500, ONESUB_ERROR_CODE.WEBHOOK_PROCESSING_FAILED, 'Failed to update subscription');
  }
}
