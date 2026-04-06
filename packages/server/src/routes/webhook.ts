import { Router } from 'express';
import type { Request, Response } from 'express';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type {
  AppleNotificationPayload,
  GoogleNotificationPayload,
  OneSubServerConfig,
  SubscriptionInfo,
} from '@onesub/shared';
import { ROUTES } from '@onesub/shared';
import type { SubscriptionStore } from '../store.js';
import { decodeAppleNotification, decodeJws } from '../providers/apple.js';
import {
  decodeGoogleNotification,
  validateGoogleReceipt,
  isGoogleActiveNotification,
  isGoogleCanceledNotification,
  isGoogleExpiredNotification,
} from '../providers/google.js';

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

export function createWebhookRouter(
  config: OneSubServerConfig,
  store: SubscriptionStore
): Router {
  const router = Router();

  /**
   * POST /onesub/webhook/apple
   *
   * Receives Apple App Store Server Notifications V2.
   * Apple sends a JWS-signed payload with a `signedPayload` field.
   */
  router.post(ROUTES.WEBHOOK_APPLE, async (req: Request, res: Response) => {
    // Apple sends the notification as { signedPayload: "<JWS>" }
    // For V2, the outer envelope is also a JWS. Here we accept the decoded
    // payload directly (consumers should verify/decode the outer JWS themselves,
    // or use Apple's server-side library). We also accept the inner notification
    // structure directly for testing and library consumers that pre-decode it.
    const body = req.body as { signedPayload?: string } | AppleNotificationPayload;

    let payload: AppleNotificationPayload | null = null;

    if ('notificationType' in body && body.data) {
      // Pre-decoded payload passed directly
      payload = body as AppleNotificationPayload;
    } else if ('signedPayload' in body && body.signedPayload) {
      // Decode and verify the outer JWS envelope using Apple's JWKS.
      // skipJwsVerification is derived from the apple config for consistency.
      try {
        payload = await decodeJws<AppleNotificationPayload>(
          body.signedPayload,
          config.apple?.skipJwsVerification
        );
      } catch (err) {
        console.error('[onesub/webhook/apple] Failed to decode signedPayload:', err);
        res.status(400).json({ error: 'Invalid signedPayload' });
        return;
      }
    }

    if (!payload) {
      res.status(400).json({ error: 'Unrecognised Apple notification format' });
      return;
    }

    const decoded = await decodeAppleNotification(payload, config.apple?.skipJwsVerification);
    if (!decoded) {
      // Could be a test notification or unsupported type — acknowledge it
      res.status(200).json({ received: true });
      return;
    }

    const { originalTransactionId, status, willRenew, expiresAt } = decoded;
    const notificationType = payload.notificationType;

    // Derive final status from the notification type (overrides the JWS-derived status
    // when there is an explicit signal like REVOKE or EXPIRED).
    let finalStatus: SubscriptionInfo['status'] = status;
    if (APPLE_CANCELED_TYPES.has(notificationType)) finalStatus = 'canceled';
    else if (APPLE_EXPIRED_TYPES.has(notificationType)) finalStatus = 'expired';
    else if (APPLE_ACTIVE_TYPES.has(notificationType)) finalStatus = 'active';

    try {
      const existing = await store.getByTransactionId(originalTransactionId);
      if (existing) {
        const updated: SubscriptionInfo = {
          ...existing,
          status: finalStatus,
          willRenew,
          expiresAt,
        };
        await store.save(updated);
      } else {
        // We have no record of this transaction — log and acknowledge.
        // This can happen for purchases made before the server started.
        console.warn(
          '[onesub/webhook/apple] Received notification for unknown transaction:',
          originalTransactionId
        );
      }

      res.status(200).json({ received: true });
    } catch (err) {
      console.error('[onesub/webhook/apple] Store update error:', err);
      res.status(500).json({ error: 'Failed to update subscription' });
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
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
    }

    const body = req.body as Partial<GoogleNotificationPayload>;

    if (!body.message?.data) {
      res.status(400).json({ error: 'Missing message.data' });
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
      console.warn(
        '[onesub/webhook/google] Package name mismatch:',
        packageName,
        '!==',
        config.google.packageName
      );
      res.status(400).json({ error: 'Package name mismatch' });
      return;
    }

    try {
      // Try to find the existing record by purchase token (used as originalTransactionId)
      const existing = await store.getByTransactionId(purchaseToken);

      let finalStatus: SubscriptionInfo['status'];
      if (isGoogleActiveNotification(notificationType)) {
        finalStatus = 'active';
      } else if (isGoogleCanceledNotification(notificationType)) {
        finalStatus = 'canceled';
      } else if (isGoogleExpiredNotification(notificationType)) {
        finalStatus = 'expired';
      } else {
        // Unhandled notification type (paused, deferred, etc.) — re-fetch from Play API
        finalStatus = 'active'; // optimistic; re-fetch below will correct it
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
          console.warn(
            '[onesub/webhook/google] Unknown purchase token and no serviceAccountKey to re-fetch:',
            purchaseToken
          );
        }
      }

      res.status(200).json({ received: true });
    } catch (err) {
      console.error('[onesub/webhook/google] Error handling notification:', err);
      res.status(500).json({ error: 'Failed to process notification' });
    }
  });

  return router;
}
