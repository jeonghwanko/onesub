import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { ONESUB_ERROR_CODE } from '@onesub/shared';
import type { OneSubServerConfig } from '@onesub/shared';
import { createOneSubMiddleware } from '../index.js';
import { InMemorySubscriptionStore, InMemoryPurchaseStore } from '../store.js';

/**
 * HTTP-level tests: the errorCode field is present on every 4xx/5xx response,
 * and the value matches the canonical `ONESUB_ERROR_CODE` enum. Clients can
 * rely on `errorCode` to drive programmatic branching regardless of the
 * human-readable `error` string.
 */
describe('server error codes', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let app: any;

  beforeEach(() => {
    const config: OneSubServerConfig = {
      database: { url: '' },
      adminSecret: 'test-admin-secret',
    };
    app = express();
    app.use(createOneSubMiddleware({
      ...config,
      store: new InMemorySubscriptionStore(),
      purchaseStore: new InMemoryPurchaseStore(),
    }));
  });

  // ── /onesub/validate ──────────────────────────────────────────
  describe('POST /onesub/validate', () => {
    it('invalid body → errorCode: INVALID_INPUT', async () => {
      const res = await request(app).post('/onesub/validate').send({ platform: 'not-valid' });
      expect(res.status).toBe(400);
      expect(res.body.errorCode).toBe(ONESUB_ERROR_CODE.INVALID_INPUT);
    });

    it('apple config missing → errorCode: APPLE_CONFIG_MISSING', async () => {
      const res = await request(app).post('/onesub/validate').send({
        platform: 'apple',
        receipt: 'dummy',
        userId: 'u1',
        productId: 'p1',
      });
      expect(res.status).toBe(500);
      expect(res.body.errorCode).toBe(ONESUB_ERROR_CODE.APPLE_CONFIG_MISSING);
    });

    it('google config missing → errorCode: GOOGLE_CONFIG_MISSING', async () => {
      const res = await request(app).post('/onesub/validate').send({
        platform: 'google',
        receipt: 'dummy',
        userId: 'u1',
        productId: 'p1',
      });
      expect(res.status).toBe(500);
      expect(res.body.errorCode).toBe(ONESUB_ERROR_CODE.GOOGLE_CONFIG_MISSING);
    });
  });

  // ── /onesub/status ────────────────────────────────────────────
  describe('GET /onesub/status', () => {
    it('missing userId → errorCode: INVALID_INPUT', async () => {
      const res = await request(app).get('/onesub/status');
      expect(res.status).toBe(400);
      expect(res.body.errorCode).toBe(ONESUB_ERROR_CODE.INVALID_INPUT);
    });

    it('oversize userId → errorCode: USER_ID_TOO_LONG', async () => {
      const res = await request(app).get('/onesub/status').query({ userId: 'x'.repeat(300) });
      expect(res.status).toBe(400);
      expect(res.body.errorCode).toBe(ONESUB_ERROR_CODE.USER_ID_TOO_LONG);
    });
  });

  // ── /onesub/purchase/validate ────────────────────────────────
  describe('POST /onesub/purchase/validate', () => {
    it('invalid body → errorCode: INVALID_INPUT', async () => {
      const res = await request(app).post('/onesub/purchase/validate').send({});
      expect(res.status).toBe(400);
      expect(res.body.errorCode).toBe(ONESUB_ERROR_CODE.INVALID_INPUT);
    });

    it('non-consumable already owned → errorCode: NON_CONSUMABLE_ALREADY_OWNED', async () => {
      // Pre-seed the store with a purchase
      const purchaseStore = new InMemoryPurchaseStore();
      await purchaseStore.savePurchase({
        transactionId: 'tx_1',
        userId: 'u1',
        productId: 'premium',
        platform: 'apple',
        type: 'non_consumable',
        quantity: 1,
        purchasedAt: new Date().toISOString(),
      });

      const app2 = express();
      app2.use(createOneSubMiddleware({
        database: { url: '' },
        apple: { bundleId: 'com.test' },
        store: new InMemorySubscriptionStore(),
        purchaseStore,
      }));

      const res = await request(app2).post('/onesub/purchase/validate').send({
        platform: 'apple',
        receipt: 'dummy',
        userId: 'u1',
        productId: 'premium',
        type: 'non_consumable',
      });
      expect(res.status).toBe(409);
      expect(res.body.errorCode).toBe(ONESUB_ERROR_CODE.NON_CONSUMABLE_ALREADY_OWNED);
    });
  });

  // ── /onesub/webhook/apple ────────────────────────────────────
  describe('POST /onesub/webhook/apple', () => {
    it('missing signedPayload → errorCode: MISSING_SIGNED_PAYLOAD', async () => {
      const res = await request(app).post('/onesub/webhook/apple').send({});
      expect(res.status).toBe(400);
      expect(res.body.errorCode).toBe(ONESUB_ERROR_CODE.MISSING_SIGNED_PAYLOAD);
    });

    it('invalid signedPayload → errorCode: INVALID_SIGNED_PAYLOAD', async () => {
      const res = await request(app).post('/onesub/webhook/apple').send({ signedPayload: 'not-a-jws' });
      expect(res.status).toBe(400);
      expect(res.body.errorCode).toBe(ONESUB_ERROR_CODE.INVALID_SIGNED_PAYLOAD);
    });
  });

  // ── /onesub/webhook/google ───────────────────────────────────
  describe('POST /onesub/webhook/google', () => {
    it('missing message.data → errorCode: MISSING_MESSAGE_DATA', async () => {
      const res = await request(app).post('/onesub/webhook/google').send({});
      expect(res.status).toBe(400);
      expect(res.body.errorCode).toBe(ONESUB_ERROR_CODE.MISSING_MESSAGE_DATA);
    });
  });

  // ── /onesub/purchase/admin/* ─────────────────────────────────
  describe('admin routes', () => {
    it('missing admin secret → errorCode: INVALID_ADMIN_SECRET', async () => {
      const res = await request(app).delete('/onesub/purchase/admin/u1/premium');
      expect(res.status).toBe(401);
      expect(res.body.errorCode).toBe(ONESUB_ERROR_CODE.INVALID_ADMIN_SECRET);
    });

    it('transfer with unknown tx → errorCode: TRANSACTION_NOT_FOUND', async () => {
      const res = await request(app)
        .post('/onesub/purchase/admin/transfer')
        .set('x-admin-secret', 'test-admin-secret')
        .send({ transactionId: 'ghost', newUserId: 'new_user' });
      expect(res.status).toBe(404);
      expect(res.body.errorCode).toBe(ONESUB_ERROR_CODE.TRANSACTION_NOT_FOUND);
    });

    it('grant with bad body → errorCode: INVALID_INPUT', async () => {
      const res = await request(app)
        .post('/onesub/purchase/admin/grant')
        .set('x-admin-secret', 'test-admin-secret')
        .send({});
      expect(res.status).toBe(400);
      expect(res.body.errorCode).toBe(ONESUB_ERROR_CODE.INVALID_INPUT);
    });
  });
});
