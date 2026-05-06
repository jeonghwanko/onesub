import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { Request, Response } from 'express';
import type { GoogleNotificationPayload, OneSubServerConfig, SubscriptionInfo } from '@onesub/shared';
import { SUBSCRIPTION_STATUS, ONESUB_ERROR_CODE } from '@onesub/shared';
import type { SubscriptionStore, PurchaseStore } from '../store.js';
import {
  decodeGoogleNotification,
  decodeGoogleVoidedNotification,
  decodeGoogleOneTimeProductNotification,
  validateGoogleReceipt,
  acknowledgeGoogleProduct,
  isGoogleActiveNotification,
  isGoogleCanceledNotification,
  isGoogleExpiredNotification,
  isGoogleGracePeriodNotification,
  isGoogleOnHoldNotification,
  isGooglePausedNotification,
  isGooglePriceChangeConfirmedNotification,
} from '../providers/google.js';
import { log } from '../logger.js';
import { sendError } from '../errors.js';
import type { WebhookEventStore } from '../webhook-events.js';

const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';

let googleJwks: ReturnType<typeof createRemoteJWKSet> | null = null;

function getGoogleJwks(): ReturnType<typeof createRemoteJWKSet> {
  if (!googleJwks) googleJwks = createRemoteJWKSet(new URL(GOOGLE_JWKS_URL));
  return googleJwks;
}

export async function verifyGooglePushToken(req: Request, expectedAudience: string): Promise<boolean> {
  const authHeader = req.headers['authorization'];
  if (typeof authHeader !== 'string' || !authHeader.startsWith('Bearer ')) return false;
  try {
    await jwtVerify(authHeader.slice('Bearer '.length).trim(), getGoogleJwks(), {
      audience: expectedAudience,
    });
    return true;
  } catch {
    return false;
  }
}

export async function handleGoogleWebhook(
  req: Request,
  res: Response,
  config: OneSubServerConfig,
  store: SubscriptionStore,
  purchaseStore: PurchaseStore,
  webhookEventStore?: WebhookEventStore,
): Promise<void> {
  if (config.google?.pushAudience) {
    const authenticated = await verifyGooglePushToken(req, config.google.pushAudience);
    if (!authenticated) {
      sendError(res, 401, ONESUB_ERROR_CODE.UNAUTHORIZED, 'Unauthorized');
      return;
    }
  }

  const body = req.body as Partial<GoogleNotificationPayload>;

  if (!body.message?.data) {
    sendError(res, 400, ONESUB_ERROR_CODE.MISSING_MESSAGE_DATA, 'Missing message.data');
    return;
  }

  if (webhookEventStore && typeof body.message.messageId === 'string') {
    const fresh = await webhookEventStore.markIfNew('google', body.message.messageId);
    if (!fresh) {
      log.info('[onesub/webhook/google] dedupe: already processed', body.message.messageId);
      res.status(200).json({ received: true, deduped: true });
      return;
    }
  }

  const voided = decodeGoogleVoidedNotification(body as GoogleNotificationPayload);
  if (voided) {
    if (config.google?.packageName && voided.packageName !== config.google.packageName) {
      log.warn('[onesub/webhook/google] voided package name mismatch:', voided.packageName, '!==', config.google.packageName);
      sendError(res, 400, ONESUB_ERROR_CODE.PACKAGE_NAME_MISMATCH, 'Package name mismatch');
      return;
    }

    try {
      if (voided.productType === 1) {
        const existing = await store.getByTransactionId(voided.purchaseToken);
        if (existing) {
          const updated = config.refundPolicy === 'until_expiry'
            ? { ...existing, willRenew: false }
            : { ...existing, status: SUBSCRIPTION_STATUS.CANCELED };
          await store.save(updated);
        } else {
          log.warn('[onesub/webhook/google] voided subscription for unknown purchaseToken:', voided.purchaseToken);
        }
      } else {
        const removed = await purchaseStore.deletePurchaseByTransactionId(voided.orderId);
        if (!removed) {
          log.warn('[onesub/webhook/google] voided IAP for unknown orderId:', voided.orderId);
        }
      }
      res.status(200).json({ received: true });
    } catch (err) {
      log.error('[onesub/webhook/google] voided notification error:', err);
      sendError(res, 500, ONESUB_ERROR_CODE.WEBHOOK_PROCESSING_FAILED, 'Failed to process voided notification');
    }
    return;
  }

  // oneTimeProductNotification — consumable / non-consumable purchase signal.
  // The notification carries no userId, so we cannot create a purchase record
  // here (the client's POST /onesub/purchase/validate is the authoritative path).
  // For PURCHASED we acknowledge to prevent the 3-day auto-refund window.
  const oneTimeProduct = decodeGoogleOneTimeProductNotification(body as GoogleNotificationPayload);
  if (oneTimeProduct) {
    if (config.google?.packageName && oneTimeProduct.packageName !== config.google.packageName) {
      log.warn('[onesub/webhook/google] oneTimeProduct package name mismatch:', oneTimeProduct.packageName, '!==', config.google.packageName);
      sendError(res, 400, ONESUB_ERROR_CODE.PACKAGE_NAME_MISMATCH, 'Package name mismatch');
      return;
    }
    try {
      const { notificationType, purchaseToken, sku } = oneTimeProduct;
      if (notificationType === 1 /* PURCHASED */) {
        log.info('[onesub/webhook/google] oneTimeProduct PURCHASED:', sku);
        if (config.google?.serviceAccountKey && config.google.packageName) {
          void acknowledgeGoogleProduct(purchaseToken, sku, config.google).catch(
            (err) => log.warn(`[onesub/webhook/google] oneTimeProduct ack failed for SKU ${sku} — 3-day auto-refund risk:`, err),
          );
        }
      } else {
        // notificationType === 2: CANCELED (user aborted before purchase completed)
        log.info('[onesub/webhook/google] oneTimeProduct CANCELED (pre-completion):', sku);
      }
      res.status(200).json({ received: true });
    } catch (err) {
      log.error('[onesub/webhook/google] oneTimeProduct error:', err);
      sendError(res, 500, ONESUB_ERROR_CODE.WEBHOOK_PROCESSING_FAILED, 'Failed to process oneTimeProduct notification');
    }
    return;
  }

  const notification = decodeGoogleNotification(body as GoogleNotificationPayload);
  if (!notification) {
    res.status(200).json({ received: true });
    return;
  }

  const { notificationType, purchaseToken, subscriptionId, packageName } = notification;

  if (config.google?.packageName && packageName !== config.google.packageName) {
    log.warn('[onesub/webhook/google] Package name mismatch:', packageName, '!==', config.google.packageName);
    sendError(res, 400, ONESUB_ERROR_CODE.PACKAGE_NAME_MISMATCH, 'Package name mismatch');
    return;
  }

  try {
    const existing = await store.getByTransactionId(purchaseToken);

    let finalStatus: SubscriptionInfo['status'];
    if (isGoogleActiveNotification(notificationType)) {
      finalStatus = SUBSCRIPTION_STATUS.ACTIVE;
    } else if (isGoogleGracePeriodNotification(notificationType)) {
      finalStatus = SUBSCRIPTION_STATUS.GRACE_PERIOD;
    } else if (isGoogleOnHoldNotification(notificationType)) {
      finalStatus = SUBSCRIPTION_STATUS.ON_HOLD;
    } else if (isGooglePausedNotification(notificationType)) {
      finalStatus = SUBSCRIPTION_STATUS.PAUSED;
    } else if (isGooglePriceChangeConfirmedNotification(notificationType)) {
      finalStatus = SUBSCRIPTION_STATUS.ACTIVE;
    } else if (isGoogleCanceledNotification(notificationType)) {
      finalStatus = SUBSCRIPTION_STATUS.CANCELED;
    } else if (isGoogleExpiredNotification(notificationType)) {
      finalStatus = SUBSCRIPTION_STATUS.EXPIRED;
    } else {
      finalStatus = SUBSCRIPTION_STATUS.ACTIVE;
    }

    if (isGooglePriceChangeConfirmedNotification(notificationType) && config.google?.onPriceChangeConfirmed) {
      const hook = config.google.onPriceChangeConfirmed;
      void Promise.resolve()
        .then(() => hook({ purchaseToken, subscriptionId, packageName }))
        .catch((err) => log.warn('[onesub/webhook/google] onPriceChangeConfirmed hook failed:', err));
    }

    if (existing) {
      let updated: SubscriptionInfo = { ...existing, status: finalStatus };

      if (config.google?.serviceAccountKey) {
        const fresh = await validateGoogleReceipt(purchaseToken, subscriptionId, config.google);
        if (fresh) {
          const preserveNotificationStatus =
            finalStatus === SUBSCRIPTION_STATUS.GRACE_PERIOD ||
            finalStatus === SUBSCRIPTION_STATUS.ON_HOLD;
          updated = {
            ...existing,
            status: preserveNotificationStatus ? finalStatus : fresh.status,
            expiresAt: fresh.expiresAt,
            willRenew: fresh.willRenew,
            autoResumeTime: fresh.autoResumeTime,
            linkedPurchaseToken: fresh.linkedPurchaseToken ?? existing.linkedPurchaseToken,
          };
        }
      }

      await store.save(updated);
    } else {
      if (config.google?.serviceAccountKey) {
        const fresh = await validateGoogleReceipt(purchaseToken, subscriptionId, config.google);
        if (fresh) {
          if (fresh.linkedPurchaseToken) {
            const previous = await store.getByTransactionId(fresh.linkedPurchaseToken);
            fresh.userId = previous ? previous.userId : purchaseToken;
            if (previous) {
              log.info(`[onesub/webhook/google] inherited userId ${previous.userId} from linkedPurchaseToken ${fresh.linkedPurchaseToken} → new token ${purchaseToken}`);
            }
          } else {
            fresh.userId = purchaseToken;
          }
          await store.save(fresh);
        }
      } else {
        log.warn('[onesub/webhook/google] Unknown purchase token and no serviceAccountKey to re-fetch:', purchaseToken);
      }
    }

    res.status(200).json({ received: true });
  } catch (err) {
    log.error('[onesub/webhook/google] Error handling notification:', err);
    sendError(res, 500, ONESUB_ERROR_CODE.WEBHOOK_PROCESSING_FAILED, 'Failed to process notification');
  }
}
