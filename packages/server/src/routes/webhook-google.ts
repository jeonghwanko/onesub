import { createRemoteJWKSet, jwtVerify } from 'jose';
import { randomUUID } from 'node:crypto';
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
import type {
  GoogleVoidedNotification,
  GoogleOneTimeProductNotification,
} from '../providers/google.js';
import { log } from '../logger.js';
import { getAppRegistry } from '../apps.js';
import { sendError } from '../errors.js';
import type { WebhookEventStore } from '../webhook-events.js';
import { unmarkWebhookEvent } from '../webhook-events.js';
import type { WebhookQueue } from '../webhook-queue.js';

const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';

let googleJwks: ReturnType<typeof createRemoteJWKSet> | null = null;

function getGoogleJwks(): ReturnType<typeof createRemoteJWKSet> {
  if (!googleJwks) googleJwks = createRemoteJWKSet(new URL(GOOGLE_JWKS_URL));
  return googleJwks;
}

export async function verifyGooglePushToken(
  req: Request,
  expectedAudience: string,
  expectedServiceAccountEmail?: string,
): Promise<boolean> {
  const authHeader = req.headers['authorization'];
  if (typeof authHeader !== 'string' || !authHeader.startsWith('Bearer ')) return false;
  try {
    const { payload } = await jwtVerify(authHeader.slice('Bearer '.length).trim(), getGoogleJwks(), {
      audience: expectedAudience,
      // Any Google Cloud principal can mint an OIDC token with an arbitrary
      // audience — issuer (and, when configured, the push service-account
      // email) narrows acceptance to real Pub/Sub push auth tokens. Google
      // documents both issuer forms, so accept either.
      issuer: ['https://accounts.google.com', 'accounts.google.com'],
    });
    if (expectedServiceAccountEmail) {
      if (payload['email'] !== expectedServiceAccountEmail || payload['email_verified'] !== true) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

/** Decoded subscription RTDN — inline shape returned by decodeGoogleNotification. */
type DecodedGoogleSubscriptionNotification = NonNullable<ReturnType<typeof decodeGoogleNotification>>;

/**
 * The unit of work handed to the state-mutating processor. Deliberately
 * JSON-serializable (a discriminated union of plain decoded notification
 * objects) so it survives a round-trip through a Redis-backed queue (BullMQ)
 * unchanged.
 */
export type GoogleWebhookWork =
  | { kind: 'voided'; voided: GoogleVoidedNotification }
  | { kind: 'oneTimeProduct'; oneTimeProduct: GoogleOneTimeProductNotification }
  | { kind: 'subscription'; notification: DecodedGoogleSubscriptionNotification };

/** Per-kind log prefixes / error messages, kept identical to the pre-refactor inline handlers. */
const GOOGLE_FAILURE_MESSAGES: Record<GoogleWebhookWork['kind'], { logPrefix: string; message: string }> = {
  voided: {
    logPrefix: '[onesub/webhook/google] voided notification error',
    message: 'Failed to process voided notification',
  },
  oneTimeProduct: {
    logPrefix: '[onesub/webhook/google] oneTimeProduct error',
    message: 'Failed to process oneTimeProduct notification',
  },
  subscription: {
    logPrefix: '[onesub/webhook/google] Error handling notification',
    message: 'Failed to process notification',
  },
};

/**
 * Whether this config serves Google Play at all — top-level `google`, or any
 * entry in `apps[]` with a `google` block.
 *
 * Single source of truth for two decisions that have to agree: whether
 * `createWebhookRouter` mounts `POST /onesub/webhook/google`, and whether
 * `warnIfGoogleWebhookOpen` has anything to warn about. If they disagreed, a
 * deployment would either be warned about a route it does not expose, or expose
 * one nothing warned about.
 */
export function servesGoogle(config: OneSubServerConfig): boolean {
  return getAppRegistry(config).apps.some((app) => !!app.google);
}

/**
 * Startup check for the two conditions that leave `POST /onesub/webhook/google`
 * open. Called once from `createOneSubMiddleware`; warns rather than throws
 * because rejecting would break deployments that front the route with their own
 * Pub/Sub verification.
 *
 * Gated on `NODE_ENV=production` for the same reason the mockMode guard is:
 * neither condition is meaningful locally, where no real RTDN arrives, and
 * warning unconditionally would fire on nearly every test and drown itself out.
 *
 * Why it matters. The subscription paths re-fetch state from Google before
 * writing, so a forged notification cannot fabricate an entitlement. The voided
 * path does not: it acts on the payload alone, setting a subscription to
 * `canceled` by `purchaseToken` or deleting a one-time purchase row by
 * `orderId`. So the exposure is entitlement *revocation* for a caller who knows
 * or guesses one of those ids — not free entitlement.
 */
/**
 * True when at least one app declares a `pushAudience`, so an incoming RTDN can be
 * cryptographically attributed to Google.
 *
 * Shared by the boot warning and the handler on purpose. When those two answered the
 * question separately they could disagree — the warning saying the endpoint is open
 * while the handler rejects, or worse the reverse.
 */
function googleWebhookIsAuthenticated(config: OneSubServerConfig): boolean {
  return getAppRegistry(config).apps.some((a) => a.google?.pushAudience);
}

/** True when an app opts into running the webhook unauthenticated in production. */
function googleWebhookAllowsUnauthenticated(config: OneSubServerConfig): boolean {
  return getAppRegistry(config).apps.some((a) => a.google?.allowUnauthenticatedWebhook);
}

export function warnIfGoogleWebhookOpen(config: OneSubServerConfig): void {
  if (process.env['NODE_ENV'] !== 'production') return;
  // Nothing to warn about when the route is not mounted at all.
  if (!servesGoogle(config)) return;

  const apps = getAppRegistry(config).apps;

  if (!googleWebhookIsAuthenticated(config)) {
    if (googleWebhookAllowsUnauthenticated(config)) {
      // Explicitly opted in. Still worth a line every boot: whoever reads the logs
      // during an incident should not have to go and check the config to learn that
      // this endpoint trusts its caller.
      log.warn(
        '[onesub] SECURITY: POST /onesub/webhook/google runs unauthenticated by explicit opt-in — ' +
          'google.allowUnauthenticatedWebhook is set and no app sets google.pushAudience. Anything ' +
          'that can reach this endpoint can cancel a subscription or delete a one-time purchase, so ' +
          'the request must already be authenticated in front of this server.',
      );
    } else {
      // Was a silent accept before 0.27.0. It is now a 401, so the warning has to
      // say the endpoint is refusing traffic — an operator reading "insecure" would
      // go looking for a security problem instead of a missing config value.
      log.warn(
        '[onesub] POST /onesub/webhook/google will reject every request with 401 — no configured ' +
          'app sets google.pushAudience, so the Pub/Sub OIDC token cannot be verified. Set ' +
          'google.pushAudience (and google.pushServiceAccountEmail), or set ' +
          'google.allowUnauthenticatedWebhook when something in front of this server already ' +
          'authenticates the request.',
      );
    }
  }

  // Open mode: any packageName is served, so a notification does not even have
  // to name an app this server knows.
  if (!apps.some((a) => a.google?.packageName)) {
    log.warn(
      '[onesub] POST /onesub/webhook/google is in open mode — no configured app declares ' +
        'google.packageName, so notifications for ANY package are accepted. ' +
        'Set google.packageName on each app you serve.',
    );
  }
}

/**
 * Resolves an RTDN's package to an app.
 *
 * When no configured app declares a packageName the instance is in legacy "open
 * mode" — it accepts notifications for any package and uses the default
 * credentials. Once any app names a package, only known packages are served.
 */
function googleResolver(config: OneSubServerConfig) {
  const registry = getAppRegistry(config);
  const restricted = registry.apps.some((app) => !!app.google?.packageName);
  return {
    registry,
    serves: (packageName: string): boolean =>
      !restricted || !!registry.configFor({ appId: packageName }).google,
    googleFor: (packageName: string) =>
      restricted
        ? registry.configFor({ appId: packageName }).google
        : (registry.defaultApp?.google ?? config.google),
  };
}

/**
 * State-mutating half of the Google webhook: everything AFTER the gate
 * (push-token auth, body validation, idempotency markIfNew, packageName
 * check, RTDN decode) has passed. Called from two places:
 *   - inline by `handleGoogleWebhook` when no queue is configured
 *   - by the webhook queue handler (registered in createWebhookRouter)
 * Throws on store failure — the caller decides the retry semantics (source
 * retry via 5xx inline, queue retry + dead-letter in queue mode).
 */
export async function processGoogleNotification(
  work: GoogleWebhookWork,
  config: OneSubServerConfig,
  store: SubscriptionStore,
  purchaseStore: PurchaseStore,
): Promise<void> {
  // Each notification names its own package; use that app's Google credentials
  // rather than whichever app happens to be the default.
  const { googleFor } = googleResolver(config);

  if (work.kind === 'voided') {
    const { voided } = work;
    if (voided.productType === 1) {
      const existing = await store.getByTransactionId(voided.purchaseToken);
      if (existing) {
        const updated = config.refundPolicy === 'until_expiry'
          ? { ...existing, willRenew: false }
          : { ...existing, status: SUBSCRIPTION_STATUS.CANCELED };
        await store.save(updated);
      } else {
        log.warn('[onesub/webhook/google] voided subscription for unknown purchaseToken', {
          purchaseToken: voided.purchaseToken,
        });
      }
    } else {
      const removed = await purchaseStore.deletePurchaseByTransactionId(voided.orderId);
      if (!removed) {
        log.warn('[onesub/webhook/google] voided IAP for unknown orderId', { orderId: voided.orderId });
      }
    }
    return;
  }

  // oneTimeProductNotification — consumable / non-consumable purchase signal.
  // The notification carries no userId, so we cannot create a purchase record
  // here (the client's POST /onesub/purchase/validate is the authoritative path).
  // For PURCHASED we acknowledge to prevent the 3-day auto-refund window.
  if (work.kind === 'oneTimeProduct') {
    const { notificationType, purchaseToken, sku } = work.oneTimeProduct;
    if (notificationType === 1 /* PURCHASED */) {
      log.info('[onesub/webhook/google] oneTimeProduct PURCHASED', { productId: sku });
      const googleCfg = googleFor(work.oneTimeProduct.packageName);
      if (googleCfg?.serviceAccountKey && googleCfg.packageName) {
        void acknowledgeGoogleProduct(purchaseToken, sku, googleCfg).catch(
          (err) =>
            log.warn('[onesub/webhook/google] oneTimeProduct ack failed — 3-day auto-refund risk', {
              productId: sku,
              err,
            }),
        );
      }
    } else {
      // notificationType === 2: CANCELED (user aborted before purchase completed)
      log.info('[onesub/webhook/google] oneTimeProduct CANCELED (pre-completion)', { productId: sku });
    }
    return;
  }

  const { notificationType, purchaseToken, subscriptionId, packageName } = work.notification;

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
    // Unknown/benign notification types (e.g. PAUSE_SCHEDULE_CHANGED,
    // DEFERRED) must not resurrect a canceled/expired record — preserve the
    // stored status; the re-fetch below corrects it when credentials exist.
    finalStatus = existing?.status ?? SUBSCRIPTION_STATUS.ACTIVE;
  }

  const subGoogleCfg = googleFor(packageName);

  if (isGooglePriceChangeConfirmedNotification(notificationType) && subGoogleCfg?.onPriceChangeConfirmed) {
    const hook = subGoogleCfg.onPriceChangeConfirmed;
    void Promise.resolve()
      .then(() => hook({ purchaseToken, subscriptionId, packageName }))
      .catch((err) => log.warn('[onesub/webhook/google] onPriceChangeConfirmed hook failed', { err }));
  }

  if (existing) {
    let updated: SubscriptionInfo = { ...existing, status: finalStatus };

    if (subGoogleCfg?.serviceAccountKey) {
      const fresh = await validateGoogleReceipt(purchaseToken, subscriptionId, subGoogleCfg);
      if (fresh) {
        // Preserve grace/on-hold only when the NOTIFICATION said so — a
        // finalStatus inherited from the stored record (unknown types above)
        // must not block the re-fetched status, or a lost recovery RTDN
        // leaves the record stuck on_hold while Google reports active.
        const preserveNotificationStatus =
          isGoogleGracePeriodNotification(notificationType) ||
          isGoogleOnHoldNotification(notificationType);
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
    if (subGoogleCfg?.serviceAccountKey) {
      const fresh = await validateGoogleReceipt(purchaseToken, subscriptionId, subGoogleCfg);
      if (fresh) {
        // Consume the account identity out of the record: it seeds the
        // placeholder userId, but must never be persisted (validate route
        // strips it the same way; stores/status would leak it otherwise).
        const boundAccountId = fresh.boundAccountId;
        delete fresh.boundAccountId;
        if (fresh.linkedPurchaseToken) {
          const previous = await store.getByTransactionId(fresh.linkedPurchaseToken);
          fresh.userId = previous ? previous.userId : boundAccountId ?? purchaseToken;
          if (previous) {
            log.info('[onesub/webhook/google] inherited userId from linkedPurchaseToken', {
              userId: previous.userId,
              linkedPurchaseToken: fresh.linkedPurchaseToken,
              purchaseToken,
            });
          }
        } else {
          fresh.userId = boundAccountId ?? purchaseToken;
        }
        await store.save(fresh);
      }
    } else {
      log.warn('[onesub/webhook/google] Unknown purchase token and no serviceAccountKey to re-fetch', {
        purchaseToken,
      });
    }
  }
}

export async function handleGoogleWebhook(
  req: Request,
  res: Response,
  config: OneSubServerConfig,
  store: SubscriptionStore,
  purchaseStore: PurchaseStore,
  webhookEventStore?: WebhookEventStore,
  webhookQueue?: WebhookQueue,
): Promise<void> {
  // Push auth runs before the payload is decoded, so the app is not known yet.
  // Each app pushes from its own GCP project (its own service account), so accept
  // the token when it verifies against any configured app's push identity.
  const pushIdentities = getAppRegistry(config)
    .apps.map((app) => app.google)
    .filter((g): g is NonNullable<typeof g> => !!g?.pushAudience);

  if (pushIdentities.length === 0) {
    // No push identity to verify against. Before 0.27.0 this accepted the request,
    // which made a `purchaseToken` or `orderId` sufficient to revoke an entitlement
    // — and for a Google subscription the purchase token IS the record's
    // originalTransactionId, so it is in the database, in RTDN payloads and in logs.
    // Treating it as a secret was never going to work; refusing unattributable
    // requests is what actually removes the capability.
    //
    // Production-gated, matching the mockMode guard and the sandbox-receipt
    // rejection: locally and in CI no real RTDN arrives, and requiring credentials
    // there would break every test and the `onesub dev` server for no security gain.
    if (process.env['NODE_ENV'] === 'production' && !googleWebhookAllowsUnauthenticated(config)) {
      sendError(res, 401, ONESUB_ERROR_CODE.UNAUTHORIZED, 'Unauthorized');
      return;
    }
  } else {
    let authenticated = false;
    for (const google of pushIdentities) {
      if (await verifyGooglePushToken(req, google.pushAudience!, google.pushServiceAccountEmail)) {
        authenticated = true;
        break;
      }
    }
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

  // Idempotency gate. Runs BEFORE any enqueue, so in queue mode duplicate
  // Pub/Sub deliveries never produce a second job (complemented by the
  // queue-level jobId dedup below). Capture the marked id once here — it is
  // the only id `unmarkWebhookEvent` may ever release.
  let markedEventId: string | undefined;
  if (webhookEventStore && typeof body.message.messageId === 'string') {
    const fresh = await webhookEventStore.markIfNew('google', body.message.messageId);
    if (!fresh) {
      log.info('[onesub/webhook/google] dedupe: already processed', {
        messageId: body.message.messageId,
      });
      res.status(200).json({ received: true, deduped: true });
      return;
    }
    markedEventId = body.message.messageId;
  }

  // Decode + packageName gating stays inline (cheap, and 4xx responses must
  // come from the request cycle — a queued job can't tell the source "don't
  // retry this payload").
  let work: GoogleWebhookWork;

  // The RTDN names its own package. Accept it when a configured app serves that
  // package, so a multi-app instance takes notifications for every app it knows
  // and still rejects the rest.
  const { serves: servesPackage } = googleResolver(config);

  const voided = decodeGoogleVoidedNotification(body as GoogleNotificationPayload);
  if (voided) {
    if (!servesPackage(voided.packageName)) {
      log.warn('[onesub/webhook/google] voided package name not served', {
        packageName: voided.packageName,
      });
      sendError(res, 400, ONESUB_ERROR_CODE.PACKAGE_NAME_MISMATCH, 'Package name mismatch');
      return;
    }
    work = { kind: 'voided', voided };
  } else {
    const oneTimeProduct = decodeGoogleOneTimeProductNotification(body as GoogleNotificationPayload);
    if (oneTimeProduct) {
      if (!servesPackage(oneTimeProduct.packageName)) {
        log.warn('[onesub/webhook/google] oneTimeProduct package name not served', {
          packageName: oneTimeProduct.packageName,
        });
        sendError(res, 400, ONESUB_ERROR_CODE.PACKAGE_NAME_MISMATCH, 'Package name mismatch');
        return;
      }
      work = { kind: 'oneTimeProduct', oneTimeProduct };
    } else {
      const notification = decodeGoogleNotification(body as GoogleNotificationPayload);
      if (!notification) {
        res.status(200).json({ received: true });
        return;
      }
      if (!servesPackage(notification.packageName)) {
        log.warn('[onesub/webhook/google] Package name not served', {
          packageName: notification.packageName,
        });
        sendError(res, 400, ONESUB_ERROR_CODE.PACKAGE_NAME_MISMATCH, 'Package name mismatch');
        return;
      }
      work = { kind: 'subscription', notification };
    }
  }

  if (webhookQueue) {
    // Queue mode: the cheap gating above ran inline; the state-mutating
    // processing runs in the queue handler. Ack as soon as the job is
    // durably accepted.
    //
    // Idempotency tradeoff: once enqueued, transient handler failures are the
    // QUEUE's retries (backoff + dead-letter), not Pub/Sub's — so the event
    // stays marked even if the job ultimately fails. After max attempts the
    // job lands in the dead-letter list; admin replay
    // (POST /onesub/admin/webhook-replay/:id) is the recovery path. Unmarking
    // here would let a Pub/Sub retry race the queue's retries and double-apply.
    try {
      await webhookQueue.enqueue<GoogleWebhookWork>({
        provider: 'google',
        // Stable job id feeds queue-level dedup (BullMQ jobId). Random
        // fallback when the push lacks a messageId — no dedup possible anyway.
        eventId:
          typeof body.message.messageId === 'string' ? body.message.messageId : randomUUID(),
        payload: work,
      });
      res.status(200).json({ received: true, queued: true });
    } catch (err) {
      // Enqueue itself failed (e.g. Redis down) — the job was never durably
      // accepted, so the queue can't retry it. Fall back to source-retry
      // semantics: unmark + 5xx so Pub/Sub redelivers.
      log.error('[onesub/webhook/google] Failed to enqueue webhook job', {
        kind: work.kind,
        messageId: body.message.messageId,
        err,
      });
      await unmarkWebhookEvent(webhookEventStore, 'google', markedEventId);
      sendError(res, 500, ONESUB_ERROR_CODE.WEBHOOK_PROCESSING_FAILED, GOOGLE_FAILURE_MESSAGES[work.kind].message);
    }
    return;
  }

  // Inline mode (no queue configured): process synchronously inside the
  // request. On failure, un-mark the idempotency key so the Pub/Sub retry is
  // processed instead of being deduped — otherwise a transient store failure
  // drops the event forever.
  try {
    await processGoogleNotification(work, config, store, purchaseStore);
    res.status(200).json({ received: true });
  } catch (err) {
    const { logPrefix, message } = GOOGLE_FAILURE_MESSAGES[work.kind];
    log.error(logPrefix, { kind: work.kind, err });
    await unmarkWebhookEvent(webhookEventStore, 'google', markedEventId);
    sendError(res, 500, ONESUB_ERROR_CODE.WEBHOOK_PROCESSING_FAILED, message);
  }
}
