/**
 * `POST /onesub/webhook/google` is mounted only for deployments that serve
 * Google Play.
 *
 * Why it is conditional at all: unlike Apple's route, it does not authenticate
 * unconditionally — the Pub/Sub OIDC token is verified only when an app declares
 * a `pushAudience` — and its voided-purchase branch needs no Google credentials
 * to run. It cancels a subscription by `purchaseToken`, or deletes a purchase row
 * by `orderId`, straight from the payload. So an Apple-only deployment used to
 * expose an unauthenticated endpoint that could revoke entitlement, with no
 * Google purchases for it to be about.
 *
 * Apple's route stays unconditional, and this file asserts that too: it verifies
 * the `signedPayload` JWS against the bundled Apple roots on every request
 * regardless of config, so it is not open in the same way.
 */

import { describe, it, expect } from 'vitest';
import request from 'supertest';
import express from 'express';
import type { OneSubServerConfig } from '@onesub/shared';
import { ONESUB_ERROR_CODE } from '@onesub/shared';
import { createOneSubMiddleware } from '../index.js';
import { InMemorySubscriptionStore, InMemoryPurchaseStore } from '../store.js';

function app(config: Partial<OneSubServerConfig>) {
  const server = express();
  server.use(
    createOneSubMiddleware({
      database: { url: '' },
      store: new InMemorySubscriptionStore(),
      purchaseStore: new InMemoryPurchaseStore(),
      ...config,
    }),
  );
  return server;
}

/** Reaching validation (400) proves the route is mounted; 404 proves it is not. */
const probe = (server: express.Express) =>
  request(server).post('/onesub/webhook/google').send({});

describe('mounted when the deployment serves Google', () => {
  it('top-level google config mounts it', async () => {
    const res = await probe(app({ google: { packageName: 'com.example.app' } }));
    expect(res.status).toBe(400);
    expect(res.body.errorCode).toBe(ONESUB_ERROR_CODE.MISSING_MESSAGE_DATA);
  });

  it('a google block on any apps[] entry mounts it', async () => {
    const res = await probe(
      app({
        apple: { bundleId: 'com.example.app' },
        apps: [
          { id: 'ios-only', apple: { bundleId: 'com.example.ios' } },
          { id: 'android', google: { packageName: 'com.example.android' } },
        ],
      }),
    );
    expect(res.status).toBe(400);
    expect(res.body.errorCode).toBe(ONESUB_ERROR_CODE.MISSING_MESSAGE_DATA);
  });

  it('mounts even without a packageName, since google is still configured', async () => {
    const res = await probe(app({ google: {} as OneSubServerConfig['google'] }));
    expect(res.status).toBe(400);
  });
});

describe('not mounted when the deployment does not serve Google', () => {
  it('an Apple-only deployment returns 404', async () => {
    const res = await probe(app({ apple: { bundleId: 'com.example.app' } }));
    expect(res.status).toBe(404);
  });

  it('a config with no providers at all returns 404', async () => {
    const res = await probe(app({}));
    expect(res.status).toBe(404);
  });

  it('an apps[] list with no google block returns 404', async () => {
    const res = await probe(
      app({ apps: [{ id: 'a', apple: { bundleId: 'com.example.a' } }] }),
    );
    expect(res.status).toBe(404);
  });

  it('the voided-purchase path is unreachable, not merely unauthenticated', async () => {
    // This is the behaviour the change exists for. `voidedPurchaseNotification`
    // deletes by orderId with no Google credentials and no token verification, so
    // on an Apple-only deployment it must not be reachable at all.
    const purchaseStore = new InMemoryPurchaseStore();
    await purchaseStore.savePurchase({
      transactionId: 'apple-tx-1',
      userId: 'alice',
      productId: 'lifetime_pass',
      platform: 'apple',
      type: 'non_consumable',
      quantity: 1,
      purchasedAt: '2026-04-01T00:00:00.000Z',
    });

    const server = express();
    server.use(
      createOneSubMiddleware({
        database: { url: '' },
        apple: { bundleId: 'com.example.app' },
        store: new InMemorySubscriptionStore(),
        purchaseStore,
      }),
    );

    const voided = Buffer.from(
      JSON.stringify({
        voidedPurchaseNotification: {
          orderId: 'apple-tx-1',
          purchaseToken: 'apple-tx-1',
          productType: 2,
          refundType: 1,
        },
        packageName: 'com.anything.at.all',
        eventTimeMillis: '1',
        version: '1.0',
      }),
    ).toString('base64');

    const res = await request(server)
      .post('/onesub/webhook/google')
      .send({ message: { data: voided, messageId: 'm1' }, subscription: 's' });

    expect(res.status).toBe(404);
    // The purchase survives — the row was never reachable.
    expect(await purchaseStore.getPurchaseByTransactionId('apple-tx-1')).not.toBeNull();
  });
});

describe('the Apple webhook stays unconditional', () => {
  it('is mounted even with no apple config', async () => {
    const res = await request(app({})).post('/onesub/webhook/apple').send({});
    expect(res.status).toBe(400);
    expect(res.body.errorCode).toBe(ONESUB_ERROR_CODE.MISSING_SIGNED_PAYLOAD);
  });

  it('rejects an unsigned payload rather than acting on it', async () => {
    const res = await request(app({ apple: { bundleId: 'com.example.app' } }))
      .post('/onesub/webhook/apple')
      .send({ signedPayload: 'not-a-jws' });
    expect(res.status).toBe(400);
    expect(res.body.errorCode).toBe(ONESUB_ERROR_CODE.INVALID_SIGNED_PAYLOAD);
  });
});
