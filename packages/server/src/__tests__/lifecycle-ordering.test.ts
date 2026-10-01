/**
 * Snapshot ordering (lifecycle.ts), Apple's billing grace period, and the
 * status route's choice of record — through the real routers.
 *
 * Deliveries are retried and arrive out of order. Apple's guidance is to act on
 * "the notification with the most recent signedDate"; Google's RTDN carries
 * eventTimeMillis for the same purpose. These scenarios deliver a newer event
 * first and an older one second, which arrival-order processing got wrong.
 */

import { describe, it, expect, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import type { OneSubServerConfig, SubscriptionInfo } from '@onesub/shared';
import { ROUTES, SUBSCRIPTION_STATUS } from '@onesub/shared';
import { createValidateRouter } from '../routes/validate.js';
import { createWebhookRouter } from '../routes/webhook.js';
import { createStatusRouter } from '../routes/status.js';
import { lockTransaction } from '../routes/purchase.js';
import { evaluateEntitlementFrom } from '../routes/entitlements.js';
import { InMemorySubscriptionStore, InMemoryPurchaseStore } from '../store.js';
import { FAKE_SERVICE_ACCOUNT_KEY } from './test-utils.js';
import { isStaleSnapshot, laterStateAsOf, isoFromEpochMs, snapshotTimeFromEpochMs } from '../lifecycle.js';

const DAY = 86_400_000;

function makeJws(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'ES256' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.fakesig`;
}

const config: OneSubServerConfig = {
  apple: { bundleId: 'com.example.app', skipJwsVerification: true },
  google: { packageName: 'com.example.app' },
  database: { url: '' },
};

function buildApp(store = new InMemorySubscriptionStore()) {
  const app = express();
  app.use(express.json());
  app.use(createValidateRouter(config, store));
  app.use(createStatusRouter(store));
  app.use(createWebhookRouter(config, store, new InMemoryPurchaseStore()));
  return { app, store };
}

function appleTx(orig: string, expiresDate: number, signedDate: number): string {
  return makeJws({
    bundleId: 'com.example.app',
    type: 'Auto-Renewable Subscription',
    productId: 'pro_monthly',
    transactionId: `tx_${signedDate}`,
    originalTransactionId: orig,
    purchaseDate: Date.now() - 40 * DAY,
    expiresDate,
    signedDate,
    environment: 'Production',
  });
}

function appleNotification(opts: {
  type: string;
  subtype?: string;
  orig: string;
  expiresDate: number;
  signedDate: number;
  renewal?: Record<string, unknown>;
}): object {
  return {
    signedPayload: makeJws({
      notificationType: opts.type,
      ...(opts.subtype ? { subtype: opts.subtype } : {}),
      notificationUUID: `uuid_${opts.type}_${opts.signedDate}`,
      signedDate: opts.signedDate,
      data: {
        signedTransactionInfo: appleTx(opts.orig, opts.expiresDate, opts.signedDate),
        signedRenewalInfo: makeJws({ autoRenewStatus: 1, ...opts.renewal }),
      },
    }),
  };
}

function googlePush(notificationType: number, purchaseToken: string, eventTimeMillis: number): object {
  const json = JSON.stringify({
    version: '1.0',
    packageName: 'com.example.app',
    eventTimeMillis: String(eventTimeMillis),
    subscriptionNotification: { version: '1.0', notificationType, purchaseToken, subscriptionId: 'pro_monthly' },
  });
  return { message: { data: Buffer.from(json).toString('base64'), messageId: `m_${notificationType}_${eventTimeMillis}` } };
}

function stored(overrides: Partial<SubscriptionInfo>): SubscriptionInfo {
  return {
    userId: 'u1',
    productId: 'pro_monthly',
    platform: 'apple',
    status: SUBSCRIPTION_STATUS.ACTIVE,
    expiresAt: new Date(Date.now() + 30 * DAY).toISOString(),
    originalTransactionId: 'orig',
    purchasedAt: new Date(Date.now() - 30 * DAY).toISOString(),
    willRenew: true,
    ...overrides,
  };
}

describe('lifecycle helpers', () => {
  it('treats only a strictly older snapshot as stale, and nothing as stale without both times', () => {
    const rec = { stateAsOf: '2026-01-02T00:00:00.000Z' };
    expect(isStaleSnapshot(rec, '2026-01-01T00:00:00.000Z')).toBe(true);
    expect(isStaleSnapshot(rec, '2026-01-02T00:00:00.000Z')).toBe(false);
    expect(isStaleSnapshot(rec, '2026-01-03T00:00:00.000Z')).toBe(false);
    expect(isStaleSnapshot({}, '2026-01-01T00:00:00.000Z')).toBe(false);
    expect(isStaleSnapshot(rec, undefined)).toBe(false);
    expect(isStaleSnapshot(null, '2026-01-01T00:00:00.000Z')).toBe(false);
  });

  it('picks the later time and converts store epoch values', () => {
    expect(laterStateAsOf(undefined, '2026-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')).toBe('2026-01-01T00:00:00.000Z');
    expect(laterStateAsOf(undefined, undefined)).toBeUndefined();
    expect(isoFromEpochMs('1767225600000')).toBe('2026-01-01T00:00:00.000Z');
    expect(isoFromEpochMs(1767225600000)).toBe('2026-01-01T00:00:00.000Z');
    expect(isoFromEpochMs(undefined)).toBeUndefined();
    expect(isoFromEpochMs('not-a-number')).toBeUndefined();
    // Beyond what a Date can hold — toISOString() would throw.
    expect(isoFromEpochMs('1e17')).toBeUndefined();
  });

  it('refuses a snapshot time far in the future, which would freeze the record', () => {
    const now = Date.parse('2026-01-01T00:00:00.000Z');
    expect(snapshotTimeFromEpochMs(now + 60_000, now)).toBe('2026-01-01T00:01:00.000Z');
    expect(snapshotTimeFromEpochMs(9999999999999, now)).toBeUndefined();
    expect(snapshotTimeFromEpochMs(now + 60 * 60_000, now)).toBeUndefined();
  });
});

describe('Apple webhook ordering', () => {
  it('a late EXPIRED does not roll back a renewal that was signed after it', async () => {
    const { app, store } = buildApp();
    await store.save(stored({ originalTransactionId: 'o1' }));
    const t = Date.now();
    const renewedUntil = t + 60 * DAY;

    await request(app).post(ROUTES.WEBHOOK_APPLE).send(
      appleNotification({ type: 'DID_RENEW', orig: 'o1', expiresDate: renewedUntil, signedDate: t }),
    );
    // Signed a minute earlier, delivered second (a retry).
    await request(app).post(ROUTES.WEBHOOK_APPLE).send(
      appleNotification({ type: 'EXPIRED', orig: 'o1', expiresDate: t - 1000, signedDate: t - 60_000 }),
    );

    const rec = await store.getByTransactionId('o1');
    expect(rec?.status).toBe(SUBSCRIPTION_STATUS.ACTIVE);
    expect(rec?.expiresAt).toBe(new Date(renewedUntil).toISOString());
    expect(rec?.stateAsOf).toBe(new Date(t).toISOString());
  });

  it('still applies notifications in order', async () => {
    const { app, store } = buildApp();
    await store.save(stored({ originalTransactionId: 'o2' }));
    const t = Date.now();
    await request(app).post(ROUTES.WEBHOOK_APPLE).send(
      appleNotification({ type: 'DID_RENEW', orig: 'o2', expiresDate: t + DAY, signedDate: t - 60_000 }),
    );
    await request(app).post(ROUTES.WEBHOOK_APPLE).send(
      appleNotification({ type: 'EXPIRED', orig: 'o2', expiresDate: t - 1000, signedDate: t }),
    );
    expect((await store.getByTransactionId('o2'))?.status).toBe(SUBSCRIPTION_STATUS.EXPIRED);
  });
});

describe('Apple billing grace period', () => {
  it('keeps access through gracePeriodExpiresDate although the paid period has ended', async () => {
    const { app, store } = buildApp();
    await store.save(stored({ originalTransactionId: 'g1' }));
    const t = Date.now();
    const graceEnds = t + 6 * DAY;

    // A real DID_FAIL_TO_RENEW/GRACE_PERIOD: the renewal failed at expiresDate,
    // which is therefore already past.
    await request(app).post(ROUTES.WEBHOOK_APPLE).send(
      appleNotification({
        type: 'DID_FAIL_TO_RENEW',
        subtype: 'GRACE_PERIOD',
        orig: 'g1',
        expiresDate: t - DAY,
        signedDate: t,
        renewal: { gracePeriodExpiresDate: graceEnds, isInBillingRetryPeriod: true },
      }),
    );

    const rec = await store.getByTransactionId('g1');
    expect(rec?.status).toBe(SUBSCRIPTION_STATUS.GRACE_PERIOD);
    expect(rec?.gracePeriodExpiresAt).toBe(new Date(graceEnds).toISOString());
    // expiresAt keeps meaning "paid through": hosts derive billing cycles from it,
    // and moving it forward here read as a renewal (premium rewards reopened).
    expect(rec?.expiresAt).toBe(new Date(t - DAY).toISOString());
    const status = await request(app).get(ROUTES.STATUS).query({ userId: 'u1' });
    expect(status.body.active).toBe(true);
  });

  it('drops the grace end once the subscription leaves grace', async () => {
    const { app, store } = buildApp();
    await store.save(stored({ originalTransactionId: 'g3' }));
    const t = Date.now();
    await request(app).post(ROUTES.WEBHOOK_APPLE).send(appleNotification({
      type: 'DID_FAIL_TO_RENEW', subtype: 'GRACE_PERIOD', orig: 'g3', expiresDate: t - DAY, signedDate: t - 60_000,
      renewal: { gracePeriodExpiresDate: t + 6 * DAY },
    }));
    await request(app).post(ROUTES.WEBHOOK_APPLE).send(appleNotification({
      type: 'GRACE_PERIOD_EXPIRED', orig: 'g3', expiresDate: t - DAY, signedDate: t,
    }));
    const rec = await store.getByTransactionId('g3');
    expect(rec?.status).toBe(SUBSCRIPTION_STATUS.ON_HOLD);
    expect(rec?.gracePeriodExpiresAt).toBeUndefined();
    expect((await request(app).get(ROUTES.STATUS).query({ userId: 'u1' })).body.active).toBe(false);
  });

  it('does not extend access for a billing failure outside a grace period', async () => {
    const { app, store } = buildApp();
    await store.save(stored({ originalTransactionId: 'g2' }));
    const t = Date.now();
    await request(app).post(ROUTES.WEBHOOK_APPLE).send(
      appleNotification({
        type: 'DID_FAIL_TO_RENEW',
        orig: 'g2',
        expiresDate: t - DAY,
        signedDate: t,
        renewal: { gracePeriodExpiresDate: t + 6 * DAY },
      }),
    );
    expect((await store.getByTransactionId('g2'))?.status).toBe(SUBSCRIPTION_STATUS.ON_HOLD);
    expect((await request(app).get(ROUTES.STATUS).query({ userId: 'u1' })).body.active).toBe(false);
  });
});

describe('Apple /validate ordering', () => {
  it('a transaction signed before the refund cannot restore access, by signedDate', async () => {
    const { app, store } = buildApp();
    const t = Date.now();
    const receipt = appleTx('v1', t + 30 * DAY, t - 60_000);

    await request(app).post(ROUTES.VALIDATE).send({ platform: 'apple', receipt, userId: 'u1', productId: 'pro_monthly' });
    await request(app).post(ROUTES.WEBHOOK_APPLE).send(
      appleNotification({ type: 'REFUND', orig: 'v1', expiresDate: t + 30 * DAY, signedDate: t }),
    );
    const replay = await request(app)
      .post(ROUTES.VALIDATE)
      .send({ platform: 'apple', receipt, userId: 'u1', productId: 'pro_monthly' });

    expect(replay.body.subscription.status).toBe(SUBSCRIPTION_STATUS.CANCELED);
    expect((await store.getByTransactionId('v1'))?.stateAsOf).toBe(new Date(t).toISOString());
  });

  it('a receipt with a later expiry (a renewal) is applied, without moving stateAsOf back', async () => {
    const { app, store } = buildApp();
    const t = Date.now();
    await store.save(stored({
      originalTransactionId: 'v2',
      status: SUBSCRIPTION_STATUS.EXPIRED,
      expiresAt: new Date(t - DAY).toISOString(),
      stateAsOf: new Date(t - 60_000).toISOString(),
    }));
    const res = await request(app).post(ROUTES.VALIDATE).send({
      platform: 'apple',
      receipt: appleTx('v2', t + 30 * DAY, t),
      userId: 'u1',
      productId: 'pro_monthly',
    });
    expect(res.body.subscription.status).toBe(SUBSCRIPTION_STATUS.ACTIVE);
    const rec = await store.getByTransactionId('v2');
    expect(rec?.status).toBe(SUBSCRIPTION_STATUS.ACTIVE);
    // The receipt's snapshot time is its purchaseDate (40 days ago), older than stored.
    expect(rec?.stateAsOf).toBe(new Date(t - 60_000).toISOString());
  });

  it('a re-signed copy of the current transaction does not hide a later renewal-info notification', async () => {
    const { app, store } = buildApp();
    const t = Date.now();
    const expires = t + 20 * DAY;
    await store.save(stored({ originalTransactionId: 'v3', expiresAt: new Date(expires).toISOString(), stateAsOf: new Date(t - 5 * DAY).toISOString() }));
    // The app re-fetches its transaction (signed now) and validates it.
    await request(app).post(ROUTES.VALIDATE).send({ platform: 'apple', receipt: appleTx('v3', expires, t), userId: 'u1', productId: 'pro_monthly' });
    // Auto-renew was turned off a minute before that, and the notification lands now.
    await request(app).post(ROUTES.WEBHOOK_APPLE).send(appleNotification({
      type: 'DID_CHANGE_RENEWAL_STATUS',
      orig: 'v3',
      expiresDate: expires,
      signedDate: t - 60_000,
      renewal: { autoRenewStatus: 0 },
    }));
    expect((await store.getByTransactionId('v3'))?.willRenew).toBe(false);
  });

  it("an old receipt from another user gets that receipt's own (expired) state, never the stored entitlement", async () => {
    // 0.27 behaviour for a receipt posted under another userId is to apply it —
    // hosts depend on that (a second device on the same Apple ID). What must
    // never happen is the stored, active state being copied onto the requester.
    const { app, store } = buildApp();
    const t = Date.now();
    const victimExpiry = new Date(t + 20 * DAY).toISOString();
    await store.save(stored({ originalTransactionId: 'v4', userId: 'victim', expiresAt: victimExpiry, stateAsOf: new Date(t - DAY).toISOString() }));
    const oldReceipt = appleTx('v4', t - 10 * DAY, t - 40 * DAY);

    const res = await request(app).post(ROUTES.VALIDATE).send({ platform: 'apple', receipt: oldReceipt, userId: 'mallory', productId: 'pro_monthly' });
    expect(res.status).toBe(200);
    expect(res.body.subscription.status).toBe(SUBSCRIPTION_STATUS.EXPIRED);
    expect(res.body.subscription.expiresAt).not.toBe(victimExpiry);
    expect((await request(app).get(ROUTES.STATUS).query({ userId: 'mallory' })).body.active).toBe(false);
  });

  it('a second device posting an older, still-valid transaction of the same subscription is applied, as in 0.27', async () => {
    const { app, store } = buildApp();
    const t = Date.now();
    await store.save(stored({ originalTransactionId: 'v6', userId: 'device-a', expiresAt: new Date(t + 30 * DAY).toISOString() }));
    const res = await request(app).post(ROUTES.VALIDATE).send({
      platform: 'apple', receipt: appleTx('v6', t + 2 * DAY, t - DAY), userId: 'device-b', productId: 'pro_monthly',
    });
    expect(res.status).toBe(200);
    expect((await request(app).get(ROUTES.STATUS).query({ userId: 'device-b' })).body.active).toBe(true);
  });

  it('a refund the device later shows as reversed (no revocation, signed after) is applied', async () => {
    const { app, store } = buildApp();
    const t = Date.now();
    const expires = t + 20 * DAY;
    await store.save(stored({ originalTransactionId: 'v7', status: SUBSCRIPTION_STATUS.CANCELED, expiresAt: new Date(expires).toISOString(), stateAsOf: new Date(t - DAY).toISOString() }));
    const res = await request(app).post(ROUTES.VALIDATE).send({ platform: 'apple', receipt: appleTx('v7', expires, t), userId: 'u1', productId: 'pro_monthly' });
    expect(res.body.subscription.status).toBe(SUBSCRIPTION_STATUS.ACTIVE);
  });

  it('re-posting the last transaction of an expired subscription stores it as expired, as in 0.27', async () => {
    const { app, store } = buildApp();
    const t = Date.now();
    await store.save(stored({ originalTransactionId: 'v8', status: SUBSCRIPTION_STATUS.ACTIVE, expiresAt: new Date(t - DAY).toISOString() }));
    await request(app).post(ROUTES.VALIDATE).send({ platform: 'apple', receipt: appleTx('v8', t - DAY, t), userId: 'u1', productId: 'pro_monthly' });
    expect((await store.getByTransactionId('v8'))?.status).toBe(SUBSCRIPTION_STATUS.EXPIRED);
  });

  it('a current receipt still moves the subscription to a new account (reinstall)', async () => {
    const { app, store } = buildApp();
    const t = Date.now();
    const expires = t + 20 * DAY;
    await store.save(stored({ originalTransactionId: 'v5', userId: 'old-id', expiresAt: new Date(expires).toISOString() }));
    const res = await request(app).post(ROUTES.VALIDATE).send({ platform: 'apple', receipt: appleTx('v5', expires, t), userId: 'new-id', productId: 'pro_monthly' });
    expect(res.status).toBe(200);
    expect((await request(app).get(ROUTES.STATUS).query({ userId: 'new-id' })).body.active).toBe(true);
  });
});

describe('Apple grace period on an unmapped notification', () => {
  it('a DID_CHANGE_RENEWAL_STATUS during grace keeps access', async () => {
    const { app, store } = buildApp();
    await store.save(stored({ originalTransactionId: 'gu' }));
    const t = Date.now();
    const graceEnds = t + 6 * DAY;
    const renewal = { gracePeriodExpiresDate: graceEnds, isInBillingRetryPeriod: true };
    await request(app).post(ROUTES.WEBHOOK_APPLE).send(appleNotification({
      type: 'DID_FAIL_TO_RENEW', subtype: 'GRACE_PERIOD', orig: 'gu', expiresDate: t - DAY, signedDate: t - 60_000, renewal,
    }));
    await request(app).post(ROUTES.WEBHOOK_APPLE).send(appleNotification({
      type: 'DID_CHANGE_RENEWAL_STATUS', orig: 'gu', expiresDate: t - DAY, signedDate: t, renewal: { ...renewal, autoRenewStatus: 0 },
    }));
    const rec = await store.getByTransactionId('gu');
    expect(rec?.status).toBe(SUBSCRIPTION_STATUS.GRACE_PERIOD);
    expect(rec?.gracePeriodExpiresAt).toBe(new Date(graceEnds).toISOString());
    expect((await request(app).get(ROUTES.STATUS).query({ userId: 'u1' })).body.active).toBe(true);
  });
});

describe('Google webhook ordering', () => {
  it('a late ON_HOLD does not override a recovery that happened after it', async () => {
    const { app, store } = buildApp();
    await store.save(stored({ originalTransactionId: 'tok1', platform: 'google' }));
    const t = Date.now();

    await request(app).post(ROUTES.WEBHOOK_GOOGLE).send(googlePush(1, 'tok1', t)); // RECOVERED
    await request(app).post(ROUTES.WEBHOOK_GOOGLE).send(googlePush(5, 'tok1', t - 60_000)); // ON_HOLD, older

    const rec = await store.getByTransactionId('tok1');
    expect(rec?.status).toBe(SUBSCRIPTION_STATUS.ACTIVE);
    expect(rec?.stateAsOf).toBe(new Date(t).toISOString());
  });

  it('applies a newer ON_HOLD', async () => {
    const { app, store } = buildApp();
    await store.save(stored({ originalTransactionId: 'tok2', platform: 'google', stateAsOf: new Date(Date.now() - DAY).toISOString() }));
    await request(app).post(ROUTES.WEBHOOK_GOOGLE).send(googlePush(5, 'tok2', Date.now()));
    expect((await store.getByTransactionId('tok2'))?.status).toBe(SUBSCRIPTION_STATUS.ON_HOLD);
  });
});

describe('Google refunds and outages', () => {
  function voidedPush(purchaseToken: string, eventTimeMillis: number): object {
    const json = JSON.stringify({
      version: '1.0',
      packageName: 'com.example.app',
      eventTimeMillis: String(eventTimeMillis),
      voidedPurchaseNotification: { purchaseToken, orderId: 'GPA.1', productType: 1, refundType: 1 },
    });
    return { message: { data: Buffer.from(json).toString('base64'), messageId: `v_${eventTimeMillis}` } };
  }

  it('an RTDN from before a refund cannot revive the refunded subscription', async () => {
    const { app, store } = buildApp();
    await store.save(stored({ originalTransactionId: 'gtok', platform: 'google' }));
    const t = Date.now();
    await request(app).post(ROUTES.WEBHOOK_GOOGLE).send(voidedPush('gtok', t));
    await request(app).post(ROUTES.WEBHOOK_GOOGLE).send(googlePush(2, 'gtok', t - 60_000)); // RENEWED, older
    expect((await store.getByTransactionId('gtok'))?.status).toBe(SUBSCRIPTION_STATUS.CANCELED);
  });

  function realKeyConfig(): OneSubServerConfig {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const key = JSON.stringify({ client_email: 'sa@example.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) });
    return {
      google: { packageName: 'com.example.app', serviceAccountKey: key, allowUnauthenticatedWebhook: true },
      database: { url: '' },
    };
  }

  function webhookApp(cfg: OneSubServerConfig) {
    const store = new InMemorySubscriptionStore();
    const app = express();
    app.use(express.json());
    app.use(createWebhookRouter(cfg, store, new InMemoryPurchaseStore()));
    return { app, store };
  }

  it('fails the delivery (so Pub/Sub retries) when Play is down for a token we have never seen', async () => {
    const { app, store } = webhookApp(realKeyConfig());
    const spy = vi.spyOn(global, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
    try {
      const res = await request(app).post(ROUTES.WEBHOOK_GOOGLE).send(googlePush(4, 'brand-new-token', Date.now()));
      expect(res.status).toBe(500);
      expect(await store.getByTransactionId('brand-new-token')).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it('acknowledges, as 0.27 did, when Play refuses our credentials — retrying for days cannot fix that', async () => {
    const { app } = webhookApp(realKeyConfig());
    const spy = vi.spyOn(global, 'fetch').mockResolvedValue({ ok: false, status: 403, text: async () => 'forbidden', json: async () => ({}) } as Response);
    try {
      const res = await request(app).post(ROUTES.WEBHOOK_GOOGLE).send(googlePush(4, 'other-new-token', Date.now()));
      expect(res.status).toBe(200);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('third review: money-path regressions', () => {
  it('a replaced Google token does not keep access when its replacement was refunded', async () => {
    const { app, store } = buildApp();
    await store.save(stored({ originalTransactionId: 'tokA', platform: 'google', expiresAt: new Date(Date.now() + 300 * DAY).toISOString() }));
    await store.save(stored({ originalTransactionId: 'tokB', platform: 'google', linkedPurchaseToken: 'tokA', status: SUBSCRIPTION_STATUS.CANCELED }));
    const res = await request(app).get(ROUTES.STATUS).query({ userId: 'u1' });
    expect(res.body.active).toBe(false);
  });

  it('a new purchase of another product in a group refunded before 0.28 is applied, not kept canceled', async () => {
    const { app, store } = buildApp();
    const t = Date.now();
    // 0.27-era refund of a yearly plan: no stateAsOf, expiry far out.
    await store.save(stored({ originalTransactionId: 'grp', productId: 'pro_yearly', status: SUBSCRIPTION_STATUS.CANCELED, expiresAt: new Date(t + 300 * DAY).toISOString() }));
    const monthly = makeJws({
      bundleId: 'com.example.app', type: 'Auto-Renewable Subscription', productId: 'pro_monthly', transactionId: 'new-monthly',
      originalTransactionId: 'grp', purchaseDate: t, expiresDate: t + 30 * DAY, signedDate: t, environment: 'Production',
    });
    const res = await request(app).post(ROUTES.VALIDATE).send({ platform: 'apple', receipt: monthly, userId: 'u1', productId: 'pro_monthly' });
    expect(res.body.subscription.status).toBe(SUBSCRIPTION_STATUS.ACTIVE);
  });

  it('a refund recorded through /validate alone (no Apple webhooks) is not undone by re-posting the pre-refund copy', async () => {
    const { app, store } = buildApp();
    const t = Date.now();
    const expires = t + 20 * DAY;
    const base = { bundleId: 'com.example.app', type: 'Auto-Renewable Subscription', productId: 'pro_monthly', transactionId: 'r1', originalTransactionId: 'nr', purchaseDate: t - 10 * DAY, expiresDate: expires, environment: 'Production' };
    const preRefund = makeJws({ ...base, signedDate: t - 5 * DAY });
    const revoked = makeJws({ ...base, signedDate: t - DAY, revocationDate: t - 2 * DAY });
    await request(app).post(ROUTES.VALIDATE).send({ platform: 'apple', receipt: preRefund, userId: 'u1', productId: 'pro_monthly' });
    await request(app).post(ROUTES.VALIDATE).send({ platform: 'apple', receipt: revoked, userId: 'u1', productId: 'pro_monthly' });
    expect((await store.getByTransactionId('nr'))?.status).toBe(SUBSCRIPTION_STATUS.CANCELED);
    const replay = await request(app).post(ROUTES.VALIDATE).send({ platform: 'apple', receipt: preRefund, userId: 'u1', productId: 'pro_monthly' });
    expect(replay.body.subscription.status).toBe(SUBSCRIPTION_STATUS.CANCELED);
  });

  it('a receipt with a future purchaseDate cannot make the next real notification look stale', async () => {
    const { app, store } = buildApp();
    const t = Date.now();
    const future = makeJws({
      bundleId: 'com.example.app', type: 'Auto-Renewable Subscription', productId: 'pro_monthly', transactionId: 'f1',
      originalTransactionId: 'fut', purchaseDate: t + 8 * 60_000, expiresDate: t + 30 * DAY, signedDate: t, environment: 'Production',
    });
    await request(app).post(ROUTES.VALIDATE).send({ platform: 'apple', receipt: future, userId: 'u1', productId: 'pro_monthly' });
    expect(Date.parse((await store.getByTransactionId('fut'))!.stateAsOf!)).toBeLessThanOrEqual(Date.now());
    await request(app).post(ROUTES.WEBHOOK_APPLE).send(appleNotification({ type: 'REFUND', orig: 'fut', expiresDate: t + 30 * DAY, signedDate: Date.now() }));
    expect((await store.getByTransactionId('fut'))?.status).toBe(SUBSCRIPTION_STATUS.CANCELED);
  });

  it('a refunded (revoked) receipt cancels a subscription in its grace period', async () => {
    const { app, store } = buildApp();
    await store.save(stored({ originalTransactionId: 'gr' }));
    const t = Date.now();
    await request(app).post(ROUTES.WEBHOOK_APPLE).send(appleNotification({
      type: 'DID_FAIL_TO_RENEW', subtype: 'GRACE_PERIOD', orig: 'gr', expiresDate: t - DAY, signedDate: t - 60_000,
      renewal: { gracePeriodExpiresDate: t + 6 * DAY },
    }));
    const revoked = makeJws({
      bundleId: 'com.example.app', type: 'Auto-Renewable Subscription', productId: 'pro_monthly', transactionId: 'gr-t',
      originalTransactionId: 'gr', purchaseDate: t - 31 * DAY, expiresDate: t - DAY, signedDate: t, revocationDate: t - 1000, environment: 'Production',
    });
    const res = await request(app).post(ROUTES.VALIDATE).send({ platform: 'apple', receipt: revoked, userId: 'u1', productId: 'pro_monthly' });
    expect(res.body.subscription.status).toBe(SUBSCRIPTION_STATUS.CANCELED);
    expect((await request(app).get(ROUTES.STATUS).query({ userId: 'u1' })).body.active).toBe(false);
  });

  it('a store lookup failure does not fail the purchase validation (0.27 parity)', async () => {
    const store = new InMemorySubscriptionStore();
    store.getByTransactionId = () => Promise.reject(new Error('replica down'));
    const app = express();
    app.use(express.json());
    app.use(createValidateRouter(config, store));
    const t = Date.now();
    const res = await request(app).post(ROUTES.VALIDATE).send({ platform: 'apple', receipt: appleTx('lk', t + 30 * DAY, t), userId: 'u1', productId: 'pro_monthly' });
    expect(res.status).toBe(200);
    expect(res.body.subscription.status).toBe(SUBSCRIPTION_STATUS.ACTIVE);
  });

  it('a stale Google RTDN is retried (5xx), not acked, when Play is down for its re-fetch', async () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const key = JSON.stringify({ client_email: 'sa@example.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) });
    const cfg: OneSubServerConfig = { google: { packageName: 'com.example.app', serviceAccountKey: key, allowUnauthenticatedWebhook: true }, database: { url: '' } };
    const store = new InMemorySubscriptionStore();
    // Stored state stamped 5 minutes ahead (a server clock running fast).
    await store.save(stored({ originalTransactionId: 'skew', platform: 'google', stateAsOf: new Date(Date.now() + 5 * 60_000).toISOString() }));
    const app = express();
    app.use(express.json());
    app.use(createWebhookRouter(cfg, store, new InMemoryPurchaseStore()));
    const spy = vi.spyOn(global, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
    try {
      const res = await request(app).post(ROUTES.WEBHOOK_GOOGLE).send(googlePush(3, 'skew', Date.now())); // CANCELED (a revocation would apply regardless)
      expect(res.status).toBe(500);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('fourth review: guards and fixes', () => {
  function keyConfig(): OneSubServerConfig {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const key = JSON.stringify({ client_email: 'sa@example.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) });
    return {
      apple: { bundleId: 'com.example.app', skipJwsVerification: true },
      google: { packageName: 'com.example.app', serviceAccountKey: key, allowUnauthenticatedWebhook: true },
      database: { url: '' },
    };
  }
  function appFor(cfg: OneSubServerConfig, store = new InMemorySubscriptionStore()) {
    const app = express();
    app.use(express.json());
    app.use(createValidateRouter(cfg, store));
    app.use(createStatusRouter(store));
    app.use(createWebhookRouter(cfg, store, new InMemoryPurchaseStore()));
    return { app, store };
  }
  const playActive = {
    startTime: '2026-01-01T00:00:00Z',
    subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
    latestOrderId: 'GPA.1',
    acknowledgementState: 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED',
    lineItems: [{ productId: 'pro_monthly', expiryTime: new Date(Date.now() + 30 * DAY).toISOString(), autoRenewingPlan: { autoRenewEnabled: true } }],
  };
  function mockPlay(subscription: unknown, tokenStatus = 200) {
    return vi.spyOn(global, 'fetch').mockImplementation(async (url) => {
      const u = String(url);
      if (u.includes('oauth2.googleapis.com')) {
        return { ok: tokenStatus === 200, status: tokenStatus, json: async () => ({ access_token: 'tok', expires_in: 3600 }), text: async () => '{"error":"invalid_grant"}' } as Response;
      }
      return { ok: true, status: 200, json: async () => subscription, text: async () => JSON.stringify(subscription) } as Response;
    });
  }

  it('with credentials, a late ON_HOLD does not override the recovery Play reports', async () => {
    const { app, store } = appFor(keyConfig());
    await store.save(stored({ originalTransactionId: 'gh', platform: 'google' }));
    const spy = mockPlay(playActive);
    try {
      const t = Date.now();
      await request(app).post(ROUTES.WEBHOOK_GOOGLE).send(googlePush(1, 'gh', t)); // RECOVERED
      await request(app).post(ROUTES.WEBHOOK_GOOGLE).send(googlePush(5, 'gh', t - 60_000)); // ON_HOLD, older
      expect((await store.getByTransactionId('gh'))?.status).toBe(SUBSCRIPTION_STATUS.ACTIVE);
    } finally {
      spy.mockRestore();
    }
  });

  it("another user's expired receipt during a grace period never gets the stored grace entitlement", async () => {
    const { app, store } = appFor(config as OneSubServerConfig);
    const t = Date.now();
    await store.save(stored({ originalTransactionId: 'gx', userId: 'u1', status: SUBSCRIPTION_STATUS.GRACE_PERIOD, expiresAt: new Date(t - DAY).toISOString(), gracePeriodExpiresAt: new Date(t + 6 * DAY).toISOString() }));
    const res = await request(app).post(ROUTES.VALIDATE).send({ platform: 'apple', receipt: appleTx('gx', t - DAY, t - 40 * DAY), userId: 'u2', productId: 'pro_monthly' });
    expect(res.body.subscription.status).toBe(SUBSCRIPTION_STATUS.EXPIRED);
    expect((await request(app).get(ROUTES.STATUS).query({ userId: 'u2' })).body.active).toBe(false);
  });

  it('a rejected service-account key (OAuth 400 invalid_grant) is a retryable 503, not a final 422', async () => {
    const { app } = appFor(keyConfig());
    const spy = mockPlay(playActive, 400);
    try {
      const res = await request(app).post(ROUTES.VALIDATE).send({ platform: 'google', receipt: 'ptok-grant', userId: 'u1', productId: 'pro_monthly' });
      expect(res.status).toBe(503);
      expect(res.body.errorCode).toBe('PROVIDER_UNAVAILABLE');
    } finally {
      spy.mockRestore();
    }
  });

  it('a failed lookup still saves the receipt, even over a record with a newer snapshot time', async () => {
    const store = new InMemorySubscriptionStore();
    const t = Date.now();
    await store.save(stored({ originalTransactionId: 'lf', userId: 'u1', stateAsOf: new Date(t - 4 * DAY).toISOString() }));
    const real = store.getByTransactionId.bind(store);
    let calls = 0;
    store.getByTransactionId = (id: string) => (++calls === 1 ? Promise.reject(new Error('connection reset')) : real(id));
    const { app } = appFor(config as OneSubServerConfig, store);
    const res = await request(app).post(ROUTES.VALIDATE).send({ platform: 'apple', receipt: appleTx('lf', t + 20 * DAY, t - 5 * DAY), userId: 'u2', productId: 'pro_monthly' });
    expect(res.status).toBe(200);
    expect((await real('lf'))?.userId).toBe('u2');
  });

  it('entitlements keep counting every record, as in 0.27; /status alone drops replaced tokens', () => {
    const now = Date.now();
    const subs = [
      stored({ originalTransactionId: 'old', platform: 'google', productId: 'pro_monthly', expiresAt: new Date(now + 20 * DAY).toISOString() }),
      stored({ originalTransactionId: 'new', platform: 'google', productId: 'basic_monthly', linkedPurchaseToken: 'old' }),
    ];
    const result = evaluateEntitlementFrom(subs, [], { productIds: ['pro_monthly'] }, now);
    expect(result.active).toBe(true);
  });
});

describe('fifth review', () => {
  it("a refund under refundPolicy 'until_expiry' ends the grace period: access only to the paid period's end", async () => {
    const cfg: OneSubServerConfig = { ...config, refundPolicy: 'until_expiry' };
    const store = new InMemorySubscriptionStore();
    const app = express();
    app.use(express.json());
    app.use(createStatusRouter(store));
    app.use(createWebhookRouter(cfg, store, new InMemoryPurchaseStore()));
    const t = Date.now();
    await store.save(stored({ originalTransactionId: 'ue', status: SUBSCRIPTION_STATUS.GRACE_PERIOD, expiresAt: new Date(t - DAY).toISOString(), gracePeriodExpiresAt: new Date(t + 15 * DAY).toISOString(), stateAsOf: new Date(t - 2 * DAY).toISOString() }));
    await request(app).post(ROUTES.WEBHOOK_APPLE).send(appleNotification({ type: 'REFUND', orig: 'ue', expiresDate: t - DAY, signedDate: t }));
    expect((await store.getByTransactionId('ue'))?.gracePeriodExpiresAt).toBeUndefined();
    expect((await request(app).get(ROUTES.STATUS).query({ userId: 'u1' })).body.active).toBe(false);
  });

  it('a stale Google REVOKED with credentials during a Play outage is applied (200, canceled), not retried', async () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const key = JSON.stringify({ client_email: 'sa@example.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) });
    const cfg: OneSubServerConfig = { google: { packageName: 'com.example.app', serviceAccountKey: key, allowUnauthenticatedWebhook: true }, database: { url: '' } };
    const store = new InMemorySubscriptionStore();
    await store.save(stored({ originalTransactionId: 'rvo', platform: 'google', stateAsOf: new Date().toISOString() }));
    const app = express();
    app.use(express.json());
    app.use(createWebhookRouter(cfg, store, new InMemoryPurchaseStore()));
    const spy = vi.spyOn(global, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
    try {
      const res = await request(app).post(ROUTES.WEBHOOK_GOOGLE).send(googlePush(12, 'rvo', Date.now() - 60 * 60_000));
      expect(res.status).toBe(200);
      expect((await store.getByTransactionId('rvo'))?.status).toBe(SUBSCRIPTION_STATUS.CANCELED);
    } finally {
      spy.mockRestore();
    }
  });

  it('a Google REVOKED notification is applied even when older than the stored state and Play cannot be read', async () => {
    const { app, store } = buildApp(); // no service account: no re-fetch possible
    await store.save(stored({ originalTransactionId: 'rv', platform: 'google', stateAsOf: new Date(Date.now()).toISOString() }));
    await request(app).post(ROUTES.WEBHOOK_GOOGLE).send(googlePush(12, 'rv', Date.now() - 60 * 60_000)); // REVOKED, an hour older
    expect((await store.getByTransactionId('rv'))?.status).toBe(SUBSCRIPTION_STATUS.CANCELED);
  });
});

describe('lockTransaction', () => {
  it('serializes holders of one key, and gives up waiting after maxWaitMs', async () => {
    const locks = new Map<string, Promise<void>>();
    await lockTransaction(locks, 'k'); // never released — a hung store call
    const started = Date.now();
    const release = await lockTransaction(locks, 'k', 50);
    expect(Date.now() - started).toBeGreaterThanOrEqual(45);
    release();
    const other = await lockTransaction(locks, 'other', 50);
    other();
  });
});

describe('/status with several subscriptions', () => {
  it('reports the active subscription even when an expired one was written more recently', async () => {
    const { app, store } = buildApp();
    await store.save(stored({ originalTransactionId: 'live', productId: 'pro_monthly' }));
    // A webhook touching an old subscription makes it the most recently written row.
    await store.save(stored({
      originalTransactionId: 'old',
      productId: 'pro_yearly',
      status: SUBSCRIPTION_STATUS.EXPIRED,
      expiresAt: new Date(Date.now() - DAY).toISOString(),
    }));

    const res = await request(app).get(ROUTES.STATUS).query({ userId: 'u1' });
    expect(res.body.active).toBe(true);
    expect(res.body.subscription.originalTransactionId).toBe('live');
  });

  it('falls back to the most recent record when none grants access', async () => {
    const { app, store } = buildApp();
    await store.save(stored({ originalTransactionId: 'a', status: SUBSCRIPTION_STATUS.EXPIRED, expiresAt: new Date(Date.now() - DAY).toISOString() }));
    await store.save(stored({ originalTransactionId: 'b', status: SUBSCRIPTION_STATUS.CANCELED }));
    const res = await request(app).get(ROUTES.STATUS).query({ userId: 'u1' });
    expect(res.body.active).toBe(false);
    expect(res.body.subscription.originalTransactionId).toBe('b');
  });
});
