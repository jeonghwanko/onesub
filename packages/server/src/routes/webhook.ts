import { Router } from 'express';
import type { Request, Response } from 'express';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type {
  AppleNotificationPayload,
  GoogleNotificationPayload,
  OneSubServerConfig,
  SubscriptionInfo,
} from '@onesub/shared';
import { ROUTES, SUBSCRIPTION_STATUS, ONESUB_ERROR_CODE } from '@onesub/shared';
import type { SubscriptionStore, PurchaseStore } from '../store.js';
import { decodeAppleNotification, decodeJws } from '../providers/apple.js';
import {
  decodeGoogleNotification,
  decodeGoogleVoidedNotification,
  validateGoogleReceipt,
  isGoogleActiveNotification,
  isGoogleCanceledNotification,
  isGoogleExpiredNotification,
} from '../providers/google.js';
import { log } from '../logger.js';
import { sendError } from '../errors.js';

/**
 * Google's public JWKS endpoint used to verify Pub/Sub push JWT tokens.
 */
const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';

// Lazily initialised — the JWKS fetch only occurs when the endpoint is first hit
// and pushAudience is configured.
let googleJwks: ReturnType<typeof createRemoteJWKSet> | null = null;

function getGoogleJwks(): ReturnType<typeof createRemoteJWKSet> {
  if (!googleJwks) {
    googleJwks = createRemoteJWKSet(new URL(GOOGLE_JWKS_URL));
  }
  return googleJwks;
}

/**
 * Verifies the `Authorization: Bearer <token>` header as a Google-signed JWT
 * and checks that the `aud` claim matches `expectedAudience`.
 *
 * Returns `true` when verification succeeds, `false` otherwise.
 */
async function verifyGooglePushToken(req: Request, expectedAudience: string): Promise<boolean> {
  const authHeader = req.headers['authorization'];
  if (typeof authHeader !== 'string' || !authHeader.startsWith('Bearer ')) {
    return false;
  }

  const token = authHeader.slice('Bearer '.length).trim();
  try {
    await jwtVerify(token, getGoogleJwks(), { audience: expectedAudience });
    return true;
  } catch {
    return false;
  }
}

/**
 * Apple V2 notification types that indicate the subscription is now active.
 */
const APPLE_ACTIVE_TYPES = new Set([
  'SUBSCRIBED',
  'DID_RENEW',
  'DID_RECOVER',
  'OFFER_REDEEMED',
]);

/**
 * Apple V2 notification types that indicate cancellation.
 */
const APPLE_CANCELED_TYPES = new Set([
  'REVOKE',
  'REFUND',
  'CONSUMPTION_REQUEST',
]);

/**
 * Apple V2 notification types that indicate expiry.
 */
const APPLE_EXPIRED_TYPES = new Set([
  'EXPIRED',
  'GRACE_PERIOD_EXPIRED',
]);

/**
 * Retry / durability semantics.
 *
 * Both Apple (App Store Server Notifications V2) and Google (Pub/Sub RTDN)
 * retry on any non-2xx response:
 *   - Apple: up to 5 retries over ~3 days, exponential backoff.
 *   - Google: per-Pub/Sub-subscription retry policy (default: retries until
 *     the message is ack'd or the retention window expires, up to 7 days).
 *
 * This router uses that built-in retry instead of a local dead-letter queue:
 *
 *   4xx — the payload is unusable (missing signedPayload, bad signature,
 *         package mismatch). Return 4xx so the sender does NOT retry, since
 *         the same request would fail again.
 *   5xx — a transient failure on our side (DB down, network to Play API).
 *         Return 5xx so Apple / Google retry the notification for us.
 *   2xx — processed, or intentionally ignored (e.g. test notification).
 *
 * If you need an explicit DLQ, wrap `store.save()` with your own error
 * handler before passing the store to `createOneSubMiddleware()`.
 */
export function createWebhookRouter(
  config: OneSubServerConfig,
  store: SubscriptionStore,
  purchaseStore: PurchaseStore,
): Router {
  const router = Router();

  /**
   * POST /onesub/webhook/apple
   *
   * Receives Apple App Store Server Notifications V2.
   * Apple sends a JWS-signed payload with a `signedPayload` field.
   */
  router.post(ROUTES.WEBHOOK_APPLE, async (req: Request, res: Response) => {
    // Apple sends the notification as { signedPayload: "<JWS>" }.
    // Only the JWS-signed path is accepted. Pre-decoded payloads are rejected
    // because they bypass signature verification and allow arbitrary state changes.
    const body = req.body as { signedPayload?: string };

    if (!body.signedPayload) {
      sendError(res, 400, ONESUB_ERROR_CODE.MISSING_SIGNED_PAYLOAD, 'Missing signedPayload');
      return;
    }

    let payload: AppleNotificationPayload;

    try {
      payload = await decodeJws<AppleNotificationPayload>(
        body.signedPayload,
        config.apple?.skipJwsVerification
      );
    } catch (err) {
      log.error('[onesub/webhook/apple] Failed to decode signedPayload:', err);
      sendError(res, 400, ONESUB_ERROR_CODE.INVALID_SIGNED_PAYLOAD, 'Invalid signedPayload');
      return;
    }

    const decoded = await decodeAppleNotification(payload, config.apple?.skipJwsVerification);
    if (!decoded) {
      // Could be a test notification or unsupported type — acknowledge it
      res.status(200).json({ received: true });
      return;
    }

    const { originalTransactionId, transactionId, type, status, willRenew, expiresAt } = decoded;
    const notificationType = payload.notificationType;

    // Derive final status from the notification type (overrides the JWS-derived status
    // when there is an explicit signal like REVOKE or EXPIRED).
    let finalStatus: SubscriptionInfo['status'] = status;
    if (APPLE_CANCELED_TYPES.has(notificationType)) finalStatus = SUBSCRIPTION_STATUS.CANCELED;
    else if (APPLE_EXPIRED_TYPES.has(notificationType)) finalStatus = SUBSCRIPTION_STATUS.EXPIRED;
    else if (APPLE_ACTIVE_TYPES.has(notificationType)) finalStatus = SUBSCRIPTION_STATUS.ACTIVE;

    // IAP refund / revoke for one-time purchases (consumable / non-consumable).
    // Apple sends REFUND notifications for both subscriptions and IAP — the
    // transaction `type` field disambiguates. Subscription refunds keep flowing
    // into the SubscriptionStore branch below.
    const isOneTimePurchase = type === 'Consumable' || type === 'Non-Consumable';
    const isRefundOrRevoke = APPLE_CANCELED_TYPES.has(notificationType);

    try {
      if (isOneTimePurchase && isRefundOrRevoke) {
        // For consumables, the refunded transactionId is unique per purchase.
        // For non-consumables, transactionId === originalTransactionId, so either
        // lookup succeeds.
        const lookupId = transactionId ?? originalTransactionId;
        const removed = await purchaseStore.deletePurchaseByTransactionId(lookupId);
        if (!removed) {
          log.warn(
            '[onesub/webhook/apple] IAP refund for unknown transaction:',
            lookupId,
          );
        }
        res.status(200).json({ received: true });
        return;
      }

      const existing = await store.getByTransactionId(originalTransactionId);
      if (existing) {
        const updated: SubscriptionInfo = {
          ...existing,
          status: finalStatus,
          willRenew,
          // expiresAt may be absent on non-subscription payloads — keep the
          // previously-stored value rather than overwriting with null/empty.
          expiresAt: expiresAt ?? existing.expiresAt,
        };
        await store.save(updated);
      } else {
        // We have no record of this transaction — log and acknowledge.
        // This can happen for purchases made before the server started.
        log.warn(
          '[onesub/webhook/apple] Received notification for unknown transaction:',
          originalTransactionId
        );
      }

      res.status(200).json({ received: true });
    } catch (err) {
      log.error('[onesub/webhook/apple] Store update error:', err);
      sendError(res, 500, ONESUB_ERROR_CODE.WEBHOOK_PROCESSING_FAILED, 'Failed to update subscription');
    }
  });

  /**
   * POST /onesub/webhook/google
   *
   * Receives Google Play Real-Time Developer Notifications (RTDN) via Pub/Sub push.
   * The body is a standard Pub/Sub push message with base64-encoded data.
   */
  router.post(ROUTES.WEBHOOK_GOOGLE, async (req: Request, res: Response) => {
    // Verify Google-signed JWT when pushAudience is configured.
    // If pushAudience is not set, authentication is skipped for backward compatibility.
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

    // voidedPurchaseNotification — Google's refund/chargeback signal for both
    // subscriptions and one-time products. Routed here before the regular
    // subscriptionNotification decoder so it doesn't get swallowed as "unknown".
    const voided = decodeGoogleVoidedNotification(body as GoogleNotificationPayload);
    if (voided) {
      if (config.google?.packageName && voided.packageName !== config.google.packageName) {
        log.warn(
          '[onesub/webhook/google] voided package name mismatch:',
          voided.packageName,
          '!==',
          config.google.packageName,
        );
        sendError(res, 400, ONESUB_ERROR_CODE.PACKAGE_NAME_MISMATCH, 'Package name mismatch');
        return;
      }

      try {
        if (voided.productType === 1) {
          // Subscription refund — purchaseToken is stored as originalTransactionId.
          const existing = await store.getByTransactionId(voided.purchaseToken);
          if (existing) {
            await store.save({ ...existing, status: SUBSCRIPTION_STATUS.CANCELED });
          } else {
            log.warn(
              '[onesub/webhook/google] voided subscription for unknown purchaseToken:',
              voided.purchaseToken,
            );
          }
        } else {
          // One-time product refund — orderId is stored as transactionId.
          const removed = await purchaseStore.deletePurchaseByTransactionId(voided.orderId);
          if (!removed) {
            log.warn(
              '[onesub/webhook/google] voided IAP for unknown orderId:',
              voided.orderId,
            );
          }
        }
        res.status(200).json({ received: true });
      } catch (err) {
        log.error('[onesub/webhook/google] voided notification error:', err);
        sendError(res, 500, ONESUB_ERROR_CODE.WEBHOOK_PROCESSING_FAILED, 'Failed to process voided notification');
      }
      return;
    }

    const notification = decodeGoogleNotification(body as GoogleNotificationPayload);

    if (!notification) {
      // Test notification or unknown type — acknowledge
      res.status(200).json({ received: true });
      return;
    }

    const { notificationType, purchaseToken, subscriptionId, packageName } = notification;

    // Validate the package name matches our config
    if (config.google?.packageName && packageName !== config.google.packageName) {
      log.warn(
        '[onesub/webhook/google] Package name mismatch:',
        packageName,
        '!==',
        config.google.packageName
      );
      sendError(res, 400, ONESUB_ERROR_CODE.PACKAGE_NAME_MISMATCH, 'Package name mismatch');
      return;
    }

    try {
      // Try to find the existing record by purchase token (used as originalTransactionId)
      const existing = await store.getByTransactionId(purchaseToken);

      let finalStatus: SubscriptionInfo['status'];
      if (isGoogleActiveNotification(notificationType)) {
        finalStatus = SUBSCRIPTION_STATUS.ACTIVE;
      } else if (isGoogleCanceledNotification(notificationType)) {
        finalStatus = SUBSCRIPTION_STATUS.CANCELED;
      } else if (isGoogleExpiredNotification(notificationType)) {
        finalStatus = SUBSCRIPTION_STATUS.EXPIRED;
      } else {
        // Unhandled notification type (paused, deferred, etc.) — re-fetch from Play API
        finalStatus = SUBSCRIPTION_STATUS.ACTIVE; // optimistic; re-fetch below will correct it
      }

      if (existing) {
        // Re-validate against Play API to get the latest expiry date
        let updated: SubscriptionInfo = { ...existing, status: finalStatus };

        if (config.google?.serviceAccountKey) {
          const fresh = await validateGoogleReceipt(purchaseToken, subscriptionId, config.google);
          if (fresh) {
            updated = {
              ...existing,
              status: fresh.status,
              expiresAt: fresh.expiresAt,
              willRenew: fresh.willRenew,
            };
          }
        }

        await store.save(updated);
      } else {
        // Unknown purchase token — attempt to create a record via Play API
        if (config.google?.serviceAccountKey) {
          const fresh = await validateGoogleReceipt(purchaseToken, subscriptionId, config.google);
          if (fresh) {
            // userId is unknown at webhook time — use purchaseToken as placeholder
            fresh.userId = purchaseToken;
            await store.save(fresh);
          }
        } else {
          log.warn(
            '[onesub/webhook/google] Unknown purchase token and no serviceAccountKey to re-fetch:',
            purchaseToken
          );
        }
      }

      res.status(200).json({ received: true });
    } catch (err) {
      log.error('[onesub/webhook/google] Error handling notification:', err);
      sendError(res, 500, ONESUB_ERROR_CODE.WEBHOOK_PROCESSING_FAILED, 'Failed to process notification');
    }
  });

  return router;
}
