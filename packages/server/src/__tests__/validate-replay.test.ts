/**
 * Re-posting an old Apple signed transaction to /validate must not undo a
 * refund the server already learned about from a webhook. Signed JWS never
 * expire, so a transaction signed before the refund still decodes as valid and
 * still carries a future expiresDate — only the stored record knows better.
 */

import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { OneSubServerConfig } from '@onesub/shared';
import { ROUTES, SUBSCRIPTION_STATUS } from '@onesub/shared';
import { createValidateRouter } from '../routes/validate.js';
import { createWebhookRouter } from '../routes/webhook.js';
import { InMemorySubscriptionStore, InMemoryPurchaseStore } from '../store.js';

function makeJws(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'ES256' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.fakesig`;
}

const config: OneSubServerConfig = {
  apple: { bundleId: 'com.example.app', skipJwsVerification: true },
  database: { url: '' },
};

function signedTx(originalTransactionId: string, expiresDate: number, transactionId: string): string {
  return makeJws({
    bundleId: 'com.example.app',
    type: 'Auto-Renewable Subscription',
    productId: 'pro_monthly',
    transactionId,
    originalTransactionId,
    purchaseDate: Date.now() - 86400000,
    expiresDate,
    environment: 'Production',
  });
}

function refundNotification(signedTransactionInfo: string): { signedPayload: string } {
  return {
    signedPayload: makeJws({
      notificationType: 'REFUND',
      notificationUUID: `uuid_${Math.random()}`,
      data: { signedTransactionInfo, signedRenewalInfo: makeJws({ autoRenewStatus: 0 }) },
    }),
  };
}

function buildApp() {
  const store = new InMemorySubscriptionStore();
  const app = express();
  app.use(express.json());
  app.use(createValidateRouter(config, store));
  app.use(createWebhookRouter(config, store, new InMemoryPurchaseStore()));
  return { app, store };
}

describe('/validate replay of an Apple transaction signed before a refund', () => {
  it('keeps the refunded (canceled) status instead of re-activating', async () => {
    const { app, store } = buildApp();
    const orig = 'orig_refund_replay';
    const receipt = signedTx(orig, Date.now() + 30 * 86400000, 'tx_1');

    const first = await request(app)
      .post(ROUTES.VALIDATE)
      .send({ platform: 'apple', receipt, userId: 'u1', productId: 'pro_monthly' });
    expect(first.status).toBe(200);
    expect((await store.getByTransactionId(orig))?.status).toBe(SUBSCRIPTION_STATUS.ACTIVE);

    const refund = await request(app).post(ROUTES.WEBHOOK_APPLE).send(refundNotification(receipt));
    expect(refund.status).toBe(200);
    expect((await store.getByTransactionId(orig))?.status).toBe(SUBSCRIPTION_STATUS.CANCELED);

    const replay = await request(app)
      .post(ROUTES.VALIDATE)
      .send({ platform: 'apple', receipt, userId: 'u1', productId: 'pro_monthly' });
    expect(replay.status).toBe(200);
    expect(replay.body.subscription.status).toBe(SUBSCRIPTION_STATUS.CANCELED);
    expect((await store.getByTransactionId(orig))?.status).toBe(SUBSCRIPTION_STATUS.CANCELED);
  });

  it('accepts a newer transaction (resubscribe) for the same originalTransactionId', async () => {
    const { app, store } = buildApp();
    const orig = 'orig_resubscribe';
    const oldReceipt = signedTx(orig, Date.now() + 30 * 86400000, 'tx_old');

    await request(app)
      .post(ROUTES.VALIDATE)
      .send({ platform: 'apple', receipt: oldReceipt, userId: 'u2', productId: 'pro_monthly' });
    await request(app).post(ROUTES.WEBHOOK_APPLE).send(refundNotification(oldReceipt));
    expect((await store.getByTransactionId(orig))?.status).toBe(SUBSCRIPTION_STATUS.CANCELED);

    const newReceipt = signedTx(orig, Date.now() + 60 * 86400000, 'tx_new');
    const res = await request(app)
      .post(ROUTES.VALIDATE)
      .send({ platform: 'apple', receipt: newReceipt, userId: 'u2', productId: 'pro_monthly' });
    expect(res.status).toBe(200);
    expect(res.body.subscription.status).toBe(SUBSCRIPTION_STATUS.ACTIVE);
    expect((await store.getByTransactionId(orig))?.status).toBe(SUBSCRIPTION_STATUS.ACTIVE);
  });
});
