/**
 * End-to-end flows through the whole middleware — `createOneSubMiddleware`,
 * not individual routers — on a given pair of stores.
 *
 * Unit and router tests check each step alone. These walk one user through a
 * lifecycle the way the stores deliver it — validate, renew, a retry arriving
 * late, a billing grace period, a refund, a replayed receipt — and read the
 * result back through the public status and entitlement routes, so a step that
 * leaves the record in a state the next step mishandles shows up here.
 *
 * Callers: `full-flow.test.ts` (in-memory, Redis on ioredis-mock) and
 * `postgres-store.test.ts` (Postgres, when DATABASE_URL is set), for the same
 * table-isolation reason as the store contract.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { Express } from 'express';
import { ROUTES, SUBSCRIPTION_STATUS } from '@onesub/shared';
import { createOneSubMiddleware } from '../index.js';
import type { StoreFactory } from './store-contract.js';

const DAY = 86_400_000;

function makeJws(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'ES256' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.fakesig`;
}

function appleTx(orig: string, expiresDate: number, signedDate: number): string {
  return makeJws({
    bundleId: 'com.flow.app',
    type: 'Auto-Renewable Subscription',
    productId: 'pro_monthly',
    transactionId: `tx_${signedDate}`,
    originalTransactionId: orig,
    purchaseDate: signedDate,
    expiresDate,
    signedDate,
    environment: 'Production',
  });
}

function appleNotification(
  type: string,
  orig: string,
  expiresDate: number,
  signedDate: number,
  extra: { subtype?: string; renewal?: Record<string, unknown> } = {},
): object {
  return {
    signedPayload: makeJws({
      notificationType: type,
      ...(extra.subtype ? { subtype: extra.subtype } : {}),
      notificationUUID: `flow_${type}_${signedDate}`,
      signedDate,
      data: {
        signedTransactionInfo: appleTx(orig, expiresDate, signedDate),
        signedRenewalInfo: makeJws({ autoRenewStatus: 1, ...extra.renewal }),
      },
    }),
  };
}

export function describeFullFlow(factory: StoreFactory): void {
  describe(`${factory.name} — full middleware flow`, () => {
    let app: Express;

    beforeAll(() => factory.setup());
    afterAll(() => factory.teardown());
    beforeEach(async () => {
      const { subs, purchases } = await factory.reset();
      app = express();
      app.use(createOneSubMiddleware({
        apple: { bundleId: 'com.flow.app', skipJwsVerification: true },
        google: { packageName: 'com.flow.app', mockMode: true },
        entitlements: { premium: { productIds: ['pro_monthly', 'lifetime'] } },
        store: subs,
        purchaseStore: purchases,
      }));
    });

    const status = async (userId: string) =>
      (await request(app).get(ROUTES.STATUS).query({ userId })).body as {
        active: boolean;
        subscription: { status: string; expiresAt: string } | null;
      };
    const premium = async (userId: string) =>
      (await request(app).get(ROUTES.ENTITLEMENT).query({ userId, id: 'premium' })).body as { active: boolean };

    it('Apple subscription: validate → renew → late retry → grace → refund → replayed receipt', async () => {
      const t0 = Date.now() - 10 * 60_000;
      const receipt = appleTx('flow-orig', t0 + 30 * DAY, t0);

      // 1. The app validates the purchase.
      const validated = await request(app)
        .post(ROUTES.VALIDATE)
        .send({ platform: 'apple', receipt, userId: 'alice', productId: 'pro_monthly' });
      expect(validated.status).toBe(200);
      expect((await status('alice')).active).toBe(true);
      expect((await premium('alice')).active).toBe(true);

      // 2. Renewal, then an EXPIRED signed before it arrives late.
      const renewedUntil = t0 + 60 * DAY;
      await request(app).post(ROUTES.WEBHOOK_APPLE).send(appleNotification('DID_RENEW', 'flow-orig', renewedUntil, t0 + 2 * 60_000)).expect(200);
      await request(app).post(ROUTES.WEBHOOK_APPLE).send(appleNotification('EXPIRED', 'flow-orig', t0 - 1000, t0 + 60_000)).expect(200);
      let s = await status('alice');
      expect(s.active).toBe(true);
      expect(s.subscription?.expiresAt).toBe(new Date(renewedUntil).toISOString());

      // 3. A renewal fails into the billing grace period: still entitled.
      const graceEnds = Date.now() + 6 * DAY;
      await request(app).post(ROUTES.WEBHOOK_APPLE).send(
        appleNotification('DID_FAIL_TO_RENEW', 'flow-orig', Date.now() - DAY, t0 + 3 * 60_000, {
          subtype: 'GRACE_PERIOD',
          renewal: { gracePeriodExpiresDate: graceEnds },
        }),
      ).expect(200);
      s = await status('alice');
      expect(s.subscription?.status).toBe(SUBSCRIPTION_STATUS.GRACE_PERIOD);
      expect(s.active).toBe(true);
      expect((await premium('alice')).active).toBe(true);

      // 4. Refunded.
      await request(app).post(ROUTES.WEBHOOK_APPLE).send(appleNotification('REFUND', 'flow-orig', renewedUntil, t0 + 4 * 60_000)).expect(200);
      expect((await status('alice')).active).toBe(false);
      expect((await premium('alice')).active).toBe(false);

      // 5. The original receipt is posted again: it must not restore access.
      const replay = await request(app)
        .post(ROUTES.VALIDATE)
        .send({ platform: 'apple', receipt, userId: 'alice', productId: 'pro_monthly' });
      expect(replay.status).toBe(200);
      expect(replay.body.subscription.status).toBe(SUBSCRIPTION_STATUS.CANCELED);
      expect((await status('alice')).active).toBe(false);
    });

    it('one-time purchases: new → idempotent retry → non-consumable restore → consumables repeat', async () => {
      const buy = (receipt: string, productId: string, type: 'consumable' | 'non_consumable') =>
        request(app).post(ROUTES.VALIDATE_PURCHASE).send({ platform: 'google', receipt, userId: 'bob', productId, type });

      const first = await buy('MOCK_VALID_lifetime_1', 'lifetime', 'non_consumable');
      expect(first.status).toBe(200);
      expect(first.body.action).toBe('new');
      expect((await premium('bob')).active).toBe(true);

      // The same receipt again (a dropped response, a retry).
      const retry = await buy('MOCK_VALID_lifetime_1', 'lifetime', 'non_consumable');
      expect(retry.body.action).toBe('restored');
      expect(retry.body.purchase.transactionId).toBe(first.body.purchase.transactionId);

      // A different receipt for a non-consumable already owned: the recorded copy.
      const second = await buy('MOCK_VALID_lifetime_2', 'lifetime', 'non_consumable');
      expect(second.status).toBe(200);
      expect(second.body.action).toBe('restored');
      expect(second.body.purchase.transactionId).toBe(first.body.purchase.transactionId);

      // Consumables are separate purchases every time.
      expect((await buy('MOCK_VALID_coins_1', 'coins', 'consumable')).body.action).toBe('new');
      expect((await buy('MOCK_VALID_coins_2', 'coins', 'consumable')).body.action).toBe('new');

      const history = await request(app).get(ROUTES.PURCHASE_STATUS).query({ userId: 'bob' });
      expect(history.body.purchases).toHaveLength(3);

      // A store outage is retryable, and records nothing.
      const outage = await buy('MOCK_NETWORK_ERROR_x', 'coins', 'consumable');
      expect(outage.status).toBe(503);
      expect((await request(app).get(ROUTES.PURCHASE_STATUS).query({ userId: 'bob' })).body.purchases).toHaveLength(3);
    });
  });
}
