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
import {
  decodeAppleNotification,
  decodeJws,
  sendAppleConsumptionResponse,
  fetchAppleSubscriptionStatus,
} from '../providers/apple.js';
import {
  decodeGoogleNotification,
  decodeGoogleVoidedNotification,
  validateGoogleReceipt,
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
 * Pure EXPIRED only — GRACE_PERIOD_EXPIRED is handled separately as on_hold
 * because billing retry continues after the grace window ends.
 */
const APPLE_EXPIRED_TYPES = new Set([
  'EXPIRED',
]);

/**
 * Map an Apple notification (notificationType + optional subtype) to a
 * lifecycle state. Returns null if the notification doesn't carry an explicit
 * lifecycle signal (in which case the caller falls back to the JWS-derived status).
 *
 * Apple references:
 *   DID_FAIL_TO_RENEW + subtype GRACE_PERIOD  → GRACE_PERIOD
 *   DID_FAIL_TO_RENEW (no subtype)            → ON_HOLD (billing retry, no grace)
 *   GRACE_PERIOD_EXPIRED                      → ON_HOLD (grace ended, retry continues)
 *   EXPIRED                                   → EXPIRED (terminal, no further retries)
 *   SUBSCRIBED / DID_RENEW / DID_RECOVER /
 *     OFFER_REDEEMED                          → ACTIVE
 *   REVOKE / REFUND / CONSUMPTION_REQUEST     → CANCELED
 */
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
    } = decoded;
    const notificationType = payload.notificationType;
    const subtype = payload.subtype;

    // Derive final status from the notification type + subtype (overrides the
    // JWS-derived status when there is an explicit lifecycle signal).
    const mapped = mapAppleNotificationStatus(notificationType, subtype);
    const finalStatus: SubscriptionInfo['status'] = mapped ?? status;

    // CONSUMPTION_REQUEST — Apple is asking whether to grant a consumable
    // refund. If the host app provided a consumptionInfoProvider, call it and
    // PUT the response. Failures are logged; the webhook still 200s.
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
        // refundPolicy='until_expiry' for subscription refunds: keep status +
        // expiresAt untouched, only flip willRenew=false. The status route's
        // stale-record check will drop the user automatically once expiresAt
        // passes. Refer to OneSubServerConfig.refundPolicy for rationale.
        const isSubscriptionRefund =
          isRefundOrRevoke && !isOneTimePurchase && notificationType !== 'CONSUMPTION_REQUEST';
        const keepEntitlement = isSubscriptionRefund && config.refundPolicy === 'until_expiry';

        const updated: SubscriptionInfo = keepEntitlement
          ? { ...existing, willRenew: false }
          : {
              ...existing,
              status: finalStatus,
              willRenew,
              // expiresAt may be absent on non-subscription payloads — keep the
              // previously-stored value rather than overwriting with null/empty.
              expiresAt: expiresAt ?? existing.expiresAt,
            };
        await store.save(updated);
      } else if (config.apple?.issuerId && config.apple?.keyId && config.apple?.privateKey) {
        // No local record but App Store Server API credentials are present —
        // fetch the canonical state from Apple. This recovers from missed
        // webhooks (server downtime, queue truncation) and bootstraps
        // subscriptions purchased before this server existed.
        // userId is unknown at webhook time — store under originalTransactionId
        // as placeholder so a later /onesub/validate call can claim ownership.
        const fresh = await fetchAppleSubscriptionStatus(originalTransactionId, config.apple, {
          sandbox: environment === 'Sandbox',
        });
        if (fresh) {
          fresh.userId = originalTransactionId;
          await store.save(fresh);
        } else {
          log.warn(
            '[onesub/webhook/apple] Unknown transaction and Status API returned no record:',
            originalTransactionId,
          );
        }
      } else {
        // No local record and no API credentials to re-fetch — log and ack.
        log.warn(
          '[onesub/webhook/apple] Received notification for unknown transaction (no API creds to recover):',
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
            // refundPolicy='until_expiry' for subscription refunds: keep
            // status + expiresAt, only flip willRenew. See OneSubServerConfig.
            const updated = config.refundPolicy === 'until_expiry'
              ? { ...existing, willRenew: false }
              : { ...existing, status: SUBSCRIPTION_STATUS.CANCELED };
            await store.save(updated);
          } else {
            log.warn(
              '[onesub/webhook/google] voided subscription for unknown purchaseToken:',
              voided.purchaseToken,
            );
          }
        } else {
          // One-time product refund — orderId is stored as transactionId.
          // Always immediate (refundPolicy doesn't apply — IAP has no expiry).
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
      } else if (isGoogleGracePeriodNotification(notificationType)) {
        finalStatus = SUBSCRIPTION_STATUS.GRACE_PERIOD;
      } else if (isGoogleOnHoldNotification(notificationType)) {
        finalStatus = SUBSCRIPTION_STATUS.ON_HOLD;
      } else if (isGooglePausedNotification(notificationType)) {
        finalStatus = SUBSCRIPTION_STATUS.PAUSED;
      } else if (isGooglePriceChangeConfirmedNotification(notificationType)) {
        // User accepted a developer-initiated price change. Subscription stays
        // active; the new price kicks in at the next renewal. Host can hook
        // onPriceChangeConfirmed below to log/notify.
        finalStatus = SUBSCRIPTION_STATUS.ACTIVE;
      } else if (isGoogleCanceledNotification(notificationType)) {
        finalStatus = SUBSCRIPTION_STATUS.CANCELED;
      } else if (isGoogleExpiredNotification(notificationType)) {
        finalStatus = SUBSCRIPTION_STATUS.EXPIRED;
      } else {
        // Unhandled notification type (PAUSE_SCHEDULE_CHANGED, DEFERRED, etc.) —
        // re-fetch from Play API will correct the status (subscriptionsv2 returns
        // SUBSCRIPTION_STATE_PAUSED etc. directly).
        finalStatus = SUBSCRIPTION_STATUS.ACTIVE; // optimistic; re-fetch below will correct it
      }

      // Fire-and-forget hook for PRICE_CHANGE_CONFIRMED — happens before store
      // save so the hook still runs even if save errors out (the host's
      // analytics/notification side effect shouldn't block on DB issues).
      if (
        isGooglePriceChangeConfirmedNotification(notificationType) &&
        config.google?.onPriceChangeConfirmed
      ) {
        const hook = config.google.onPriceChangeConfirmed;
        void Promise.resolve()
          .then(() => hook({ purchaseToken, subscriptionId, packageName }))
          .catch((err) => log.warn('[onesub/webhook/google] onPriceChangeConfirmed hook failed:', err));
      }

      if (existing) {
        // Re-validate against Play API to get the latest expiry date
        let updated: SubscriptionInfo = { ...existing, status: finalStatus };

        if (config.google?.serviceAccountKey) {
          const fresh = await validateGoogleReceipt(purchaseToken, subscriptionId, config.google);
          if (fresh) {
            // Notification-derived grace_period/on_hold are authoritative — the
            // expiry-based deriveStatus() in the provider can't observe these
            // states (paymentState heuristics are unreliable), so trust the
            // RTDN signal over the API-derived status for those two cases.
            const preserveNotificationStatus =
              finalStatus === SUBSCRIPTION_STATUS.GRACE_PERIOD ||
              finalStatus === SUBSCRIPTION_STATUS.ON_HOLD;
            updated = {
              ...existing,
              status: preserveNotificationStatus ? finalStatus : fresh.status,
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
            // Upgrade/downgrade continuity: if the v2 response carries a
            // linkedPurchaseToken pointing at a previous subscription we know
            // about, inherit the userId from it so the same person doesn't
            // appear as a brand-new placeholder after a plan change.
            if (fresh.linkedPurchaseToken) {
              const previous = await store.getByTransactionId(fresh.linkedPurchaseToken);
              if (previous) {
                fresh.userId = previous.userId;
                log.info(
                  `[onesub/webhook/google] inherited userId ${previous.userId} from linkedPurchaseToken ${fresh.linkedPurchaseToken} → new token ${purchaseToken}`,
                );
              } else {
                fresh.userId = purchaseToken;
              }
            } else {
              // userId is unknown at webhook time — use purchaseToken as placeholder
              fresh.userId = purchaseToken;
            }
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
