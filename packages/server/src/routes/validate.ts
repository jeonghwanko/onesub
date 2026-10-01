import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { ValidateReceiptResponse, OneSubServerConfig, SubscriptionInfo } from '@onesub/shared';
import { ROUTES, ONESUB_ERROR_CODE, SUBSCRIPTION_STATUS } from '@onesub/shared';
import type { SubscriptionStore } from '../store.js';
import { validateAppleReceipt } from '../providers/apple.js';
import { validateGoogleReceipt, acknowledgeGoogleSubscription } from '../providers/google.js';
import { log } from '../logger.js';
import { laterStateAsOf } from '../lifecycle.js';
import { ProviderUnavailableError } from '../providers/errors.js';
import { sendError, parseOrSend } from '../errors.js';
import { getAppRegistry, peekAppleBundleId, unknownAppError } from '../apps.js';
import { getTestOverride } from '../test-overrides.js';

const NO_SUB = { valid: false, subscription: null } as const;

const validateSchema = z.object({
  platform: z.enum(['apple', 'google']),
  receipt: z.string().min(1).max(10000),
  userId: z.string().min(1).max(256),
  productId: z.string().min(1).max(256),
  /** Which app this receipt belongs to. Optional — see OneSubServerConfig.apps. */
  appId: z.string().min(1).max(256).optional(),
});

export function createValidateRouter(
  config: OneSubServerConfig,
  store: SubscriptionStore
): Router {
  const router = Router();
  const registry = getAppRegistry(config);

  router.post(ROUTES.VALIDATE, async (req: Request, res: Response) => {
    const body = parseOrSend(res, validateSchema, req.body, { extra: NO_SUB });
    if (!body) return;
    const { platform, receipt, userId, productId, appId } = body;

    try {
      let sub = null;

      // An Apple receipt names its own app, so an Apple client needs no appId.
      // A Google purchase token does not, so it relies on appId (or the default).
      const appHint = {
        appId,
        bundleId: platform === 'apple' ? peekAppleBundleId(receipt) : undefined,
      };
      const appConfig = registry.resolve(appHint);

      // The request named an app (appId, or the receipt's own bundleId) that
      // this instance does not host: the caller's mistake, not a server one.
      if (!appConfig && (appHint.appId || appHint.bundleId)) {
        const { code, message } = unknownAppError(appHint);
        sendError(res, 400, code, message, NO_SUB);
        return;
      }

      if (platform === 'apple') {
        if (!appConfig?.apple) {
          sendError(res, 500, ONESUB_ERROR_CODE.APPLE_CONFIG_MISSING, 'Apple configuration not provided', NO_SUB);
          return;
        }
        sub = await validateAppleReceipt(receipt, appConfig.apple);
      } else {
        if (!appConfig?.google) {
          sendError(res, 500, ONESUB_ERROR_CODE.GOOGLE_CONFIG_MISSING, 'Google configuration not provided', NO_SUB);
          return;
        }
        sub = await validateGoogleReceipt(receipt, productId, appConfig.google);
      }

      if (!sub) {
        sendError(res, 422, ONESUB_ERROR_CODE.RECEIPT_VALIDATION_FAILED, 'Receipt validation failed', NO_SUB);
        return;
      }

      // Account-binding guard (payment-bypass defense), mirroring the one-time
      // purchase route: when the receipt carries an account identity baked in at
      // purchase time (Apple appAccountToken / Google obfuscatedExternalAccountId),
      // the subscription may only be bound to a matching userId. Without this, a
      // leaked/shared receipt can be re-bound to any attacker-chosen userId.
      // Apple compares case-insensitively (appAccountToken is normalized to a
      // lowercase UUID); Google ids are verbatim — a case-insensitive compare
      // would let a case-flipped userId through on hosts with case-sensitive ids.
      const boundAccountId = sub.boundAccountId;
      delete sub.boundAccountId;
      const bindingMismatch = platform === 'apple'
        ? boundAccountId && boundAccountId.toLowerCase() !== userId.toLowerCase()
        : boundAccountId && boundAccountId !== userId;
      if (bindingMismatch) {
        log.warn('[onesub/validate] account binding mismatch — receipt token does not match userId', {
          originalTransactionId: sub.originalTransactionId,
          userId,
        });
        sendError(
          res,
          409,
          ONESUB_ERROR_CODE.TRANSACTION_BELONGS_TO_OTHER_USER,
          'TRANSACTION_BELONGS_TO_OTHER_USER',
          NO_SUB,
        );
        return;
      }

      const isSandbox = sub.sandbox === true;
      delete sub.sandbox;
      sub.userId = userId;

      const existing = await store.getByTransactionId(sub.originalTransactionId);
      if (existing && platform === 'apple') {
        const decision = decideAppleReceipt(existing, sub, userId);
        if (decision === 'outdated-transfer') {
          // An outdated receipt from this subscription's history must not move
          // the subscription to another account — nor reveal its current state.
          log.warn('[onesub/validate] outdated receipt for a subscription bound to another user', {
            originalTransactionId: sub.originalTransactionId,
            userId,
          });
          sendError(res, 409, ONESUB_ERROR_CODE.TRANSACTION_BELONGS_TO_OTHER_USER, 'TRANSACTION_BELONGS_TO_OTHER_USER', NO_SUB);
          return;
        }
        if (decision === 'keep') {
          log.info('[onesub/validate] receipt carries nothing newer than the stored state — keeping it', {
            originalTransactionId: sub.originalTransactionId,
            userId,
          });
          sub.status = existing.status;
          sub.willRenew = existing.willRenew;
          sub.expiresAt = existing.expiresAt;
        }
      }
      // Never move the record's snapshot time backwards (lifecycle.ts); the
      // store also refuses a write older than what it holds.
      const stateAsOf = laterStateAsOf(existing?.stateAsOf, sub.stateAsOf);
      if (stateAsOf) sub.stateAsOf = stateAsOf;
      else delete sub.stateAsOf;

      // Sandbox-only test override, applied last so nothing above can undo it.
      // Apple cannot cancel a sandbox subscription bought with a real Apple
      // Account, so without this a tester who subscribed once can never see the
      // paywall again. Gated on the receipt actually being a Sandbox one, so a
      // Production receipt is unaffected even when an override exists.
      if (isSandbox && getTestOverride(userId) === false) {
        log.warn('[onesub/validate] sandbox test override active — forcing not-entitled', { userId });
        sub.status = SUBSCRIPTION_STATUS.EXPIRED;
        sub.willRenew = false;
      }

      await store.save(sub);

      // Google requires acknowledgement within 3 days of purchase or the
      // transaction is auto-refunded. Fire-and-forget — entitlement is already
      // saved, ack is idempotent on the Play side.
      if (platform === 'google' && appConfig?.google) {
        void acknowledgeGoogleSubscription(receipt, productId, appConfig.google);
      }

      const response: ValidateReceiptResponse = { valid: true, subscription: sub };
      res.status(200).json(response);
    } catch (err) {
      if (err instanceof ProviderUnavailableError) {
        log.warn('[onesub/validate] store API unavailable', { userId, productId, platform, err });
        sendError(res, 503, ONESUB_ERROR_CODE.PROVIDER_UNAVAILABLE, 'Store API unavailable — retry later', NO_SUB);
        return;
      }
      log.error('[onesub/validate] Unexpected error', { userId, productId, platform, err });
      sendError(res, 500, ONESUB_ERROR_CODE.INTERNAL_ERROR, 'Internal server error during receipt validation', NO_SUB);
    }
  });

  return router;
}

/**
 * What to do with a validated Apple receipt for a subscription already stored.
 *
 * A signed transaction never expires and carries no renewal info, so it is a
 * partial, possibly old, view. It brings news only when it shows a later
 * expiry (a renewal or resubscribe) or a revocation (a refund). Anything else —
 * a re-sent copy, a receipt from before a refund, a transaction-only view of a
 * subscription now in its grace period — must not overwrite what the store's
 * notifications established. That rule needs no `stateAsOf`, so it also covers
 * records written before the field existed.
 *
 * For another user, the stored state is never copied onto the requester: that
 * would hand an old receipt's holder someone else's active subscription. A
 * receipt older than the stored one is refused outright; a current one moves
 * the subscription as before (reinstall, account migration).
 */
function decideAppleReceipt(
  existing: SubscriptionInfo,
  incoming: SubscriptionInfo,
  userId: string,
): 'apply' | 'keep' | 'outdated-transfer' {
  const later = Date.parse(incoming.expiresAt) > Date.parse(existing.expiresAt);
  const revoked = incoming.status === SUBSCRIPTION_STATUS.CANCELED && existing.status !== SUBSCRIPTION_STATUS.CANCELED;
  if (existing.userId !== userId) {
    return Date.parse(incoming.expiresAt) < Date.parse(existing.expiresAt) && !revoked ? 'outdated-transfer' : 'apply';
  }
  return later || revoked ? 'apply' : 'keep';
}
