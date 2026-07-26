/**
 * `POST /onesub/webhook/google` refuses requests it cannot attribute to Google.
 *
 * ## Why this replaced masking the purchase token
 *
 * The RTDN paths are only dangerous because a caller who knows a `purchaseToken` or
 * an `orderId` could reach them unauthenticated: the voided-purchase branch acts on
 * the payload alone, cancelling a subscription by token or deleting a one-time
 * purchase row by order id.
 *
 * Treating those ids as secrets does not work. For a Google subscription the purchase
 * token **is** the record's `originalTransactionId` (`providers/google.ts` keys on it
 * deliberately — RTDNs and `linkedPurchaseToken` chains carry nothing else), so it
 * lives in the database, in every notification payload, and in the webhook lines
 * where it is the subject of the investigation. Redacting it from logs would have left
 * the capability intact while suggesting otherwise.
 *
 * Refusing unattributable requests removes the capability instead.
 *
 * ## Production-gated, and why that is not a loophole
 *
 * Locally and in CI no real RTDN arrives, and requiring Pub/Sub credentials there
 * would break every webhook test in this repo and the `onesub dev` server for no
 * security gain. This matches how the mockMode hard guard and the sandbox-receipt
 * rejection are already gated. The residual risk — a production deployment that
 * forgets `NODE_ENV=production` — is the same one those two already carry, so this
 * adds no new footgun, and the boot warning fires on the same condition.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { ONESUB_ERROR_CODE } from '@onesub/shared';
import type { OneSubMiddlewareConfig } from '../index.js';
import { createOneSubMiddleware } from '../index.js';
import { InMemoryPurchaseStore, InMemorySubscriptionStore } from '../store.js';

const originalNodeEnv = process.env['NODE_ENV'];

afterEach(() => {
  if (originalNodeEnv === undefined) delete process.env['NODE_ENV'];
  else process.env['NODE_ENV'] = originalNodeEnv;
});

function build(google: NonNullable<OneSubMiddlewareConfig['google']>) {
  const app = express();
  app.use(
    createOneSubMiddleware({
      database: { url: '' },
      adminSecret: 'test-admin-secret-that-is-long-enough',
      google,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      store: new InMemorySubscriptionStore(),
      purchaseStore: new InMemoryPurchaseStore(),
    }),
  );
  return app;
}

/** A voided-purchase RTDN — the branch that acts on the payload without re-fetching. */
function voidedRtdn() {
  const notification = {
    version: '1.0',
    packageName: 'com.example.app',
    eventTimeMillis: '1700000000000',
    voidedPurchaseNotification: {
      purchaseToken: 'tok_victim',
      orderId: 'GPA.victim',
      productType: 1,
      refundType: 1,
    },
  };
  return {
    message: { data: Buffer.from(JSON.stringify(notification)).toString('base64'), messageId: 'm1' },
    subscription: 'projects/p/subscriptions/s',
  };
}

describe('in production', () => {
  beforeEach(() => {
    process.env['NODE_ENV'] = 'production';
  });

  it('refuses a request it cannot attribute to Google', async () => {
    const app = build({ packageName: 'com.example.app' });

    const res = await request(app).post('/onesub/webhook/google').send(voidedRtdn());

    expect(res.status).toBe(401);
    expect(res.body.errorCode).toBe(ONESUB_ERROR_CODE.UNAUTHORIZED);
  });

  it('does not act on the payload before refusing', async () => {
    // The point of the 401 is that the revocation never happens. A 401 that still
    // cancelled the subscription would be worse than the old fail-open, because it
    // would look safe.
    const store = new InMemorySubscriptionStore();
    await store.save({
      userId: 'alice',
      productId: 'monthly',
      platform: 'google',
      status: 'active',
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      originalTransactionId: 'tok_victim',
      purchasedAt: new Date().toISOString(),
      willRenew: true,
    });
    const app = express();
    app.use(
      createOneSubMiddleware({
        database: { url: '' },
        adminSecret: 'test-admin-secret-that-is-long-enough',
        google: { packageName: 'com.example.app' },
        logger: { info: () => {}, warn: () => {}, error: () => {} },
        store,
        purchaseStore: new InMemoryPurchaseStore(),
      }),
    );

    await request(app).post('/onesub/webhook/google').send(voidedRtdn());

    const after = await store.getByTransactionId('tok_victim');
    expect(after?.status).toBe('active');
    expect(after?.willRenew).toBe(true);
  });

  it('accepts when the host opts in explicitly', async () => {
    const app = build({ packageName: 'com.example.app', allowUnauthenticatedWebhook: true });

    const res = await request(app).post('/onesub/webhook/google').send(voidedRtdn());

    expect(res.status).toBe(200);
  });

  it('still refuses a bad token when pushAudience IS configured', async () => {
    // The opt-in must not become a way to bypass verification that was asked for.
    const app = build({
      packageName: 'com.example.app',
      pushAudience: 'https://api.example.com/onesub/webhook/google',
      allowUnauthenticatedWebhook: true,
    });

    const res = await request(app)
      .post('/onesub/webhook/google')
      .set('Authorization', 'Bearer not-a-real-google-token')
      .send(voidedRtdn());

    expect(res.status).toBe(401);
  });
});

describe('outside production', () => {
  it('accepts an unauthenticated request, so dev and CI need no credentials', async () => {
    process.env['NODE_ENV'] = 'development';
    const app = build({ packageName: 'com.example.app' });

    const res = await request(app).post('/onesub/webhook/google').send(voidedRtdn());

    expect(res.status).toBe(200);
  });

  it('accepts with NODE_ENV unset', async () => {
    delete process.env['NODE_ENV'];
    const app = build({ packageName: 'com.example.app' });

    const res = await request(app).post('/onesub/webhook/google').send(voidedRtdn());

    expect(res.status).toBe(200);
  });
});
