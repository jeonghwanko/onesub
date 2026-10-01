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
import express from 'express';
import request from 'supertest';
import type { OneSubServerConfig, SubscriptionInfo } from '@onesub/shared';
import { ROUTES, SUBSCRIPTION_STATUS } from '@onesub/shared';
import { createValidateRouter } from '../routes/validate.js';
import { createWebhookRouter } from '../routes/webhook.js';
import { createStatusRouter } from '../routes/status.js';
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
    expect(rec?.expiresAt).toBe(new Date(graceEnds).toISOString());
    const status = await request(app).get(ROUTES.STATUS).query({ userId: 'u1' });
    expect(status.body.active).toBe(true);
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

  it('an old receipt from another user cannot take over an active subscription, nor reveal it', async () => {
    const { app, store } = buildApp();
    const t = Date.now();
    await store.save(stored({ originalTransactionId: 'v4', userId: 'victim', expiresAt: new Date(t + 20 * DAY).toISOString(), stateAsOf: new Date(t - DAY).toISOString() }));
    const oldReceipt = appleTx('v4', t - 10 * DAY, t - 40 * DAY);

    const res = await request(app).post(ROUTES.VALIDATE).send({ platform: 'apple', receipt: oldReceipt, userId: 'mallory', productId: 'pro_monthly' });
    expect(res.status).toBe(409);
    expect(res.body.subscription).toBeNull();
    expect((await request(app).get(ROUTES.STATUS).query({ userId: 'mallory' })).body.active).toBe(false);
    expect((await request(app).get(ROUTES.STATUS).query({ userId: 'victim' })).body.active).toBe(true);
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
    expect(rec?.expiresAt).toBe(new Date(graceEnds).toISOString());
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

  it('fails the delivery (so Pub/Sub retries) when Play is down for a token we have never seen', async () => {
    const cfg: OneSubServerConfig = {
      google: { packageName: 'com.example.app', serviceAccountKey: FAKE_SERVICE_ACCOUNT_KEY, allowUnauthenticatedWebhook: true },
      database: { url: '' },
    };
    const store = new InMemorySubscriptionStore();
    const app = express();
    app.use(express.json());
    app.use(createWebhookRouter(cfg, store, new InMemoryPurchaseStore()));
    const spy = vi.spyOn(global, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
    try {
      const res = await request(app).post(ROUTES.WEBHOOK_GOOGLE).send(googlePush(4, 'brand-new-token', Date.now()));
      expect(res.status).toBe(500);
      expect(await store.getByTransactionId('brand-new-token')).toBeNull();
    } finally {
      spy.mockRestore();
    }
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
