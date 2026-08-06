/**
 * Route behaviour for a Google consumable whose token Google already reports as
 * consumed.
 *
 * This is the normal state of every purchase onesub has already handled: it
 * consumes a consumable the moment it validates it. So a consumed token arrives
 * whenever the client looks at the same purchase again — an in-session restore,
 * a pending order the store re-surfaces, a retry after a dropped response.
 *
 * The provider used to answer all of those with `null`, which the route turned
 * into `422 RECEIPT_VALIDATION_FAILED`. The Unity client reads a 422 as an
 * authoritative verdict about the receipt, so it stopped retrying and never
 * confirmed the order — a purchase onesub had on record was silently lost to a
 * player who had already been charged.
 *
 * Restore and replay are now told apart the only way they can be: by whether a
 * purchase with that transactionId is on record.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { generateKeyPairSync } from 'crypto';
import type { PurchaseInfo } from '@onesub/shared';
import { createOneSubMiddleware } from '../index.js';
import { InMemorySubscriptionStore, InMemoryPurchaseStore } from '../store.js';
import { urlHost } from './test-utils.js';

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const PACKAGE_NAME = 'com.example.app';
const PRODUCT_ID = 'credits_100';
const ORDER_ID = 'GPA.consumed-order';

function googleConfig() {
  return {
    packageName: PACKAGE_NAME,
    serviceAccountKey: JSON.stringify({
      client_email: `test-${Math.random()}@test.iam.gserviceaccount.com`,
      private_key: privateKey,
      token_uri: 'https://oauth2.googleapis.com/token',
    }),
  };
}

/**
 * Records every `:consume` / `:acknowledge` call the route makes.
 *
 * These matter as much as the status code: rejecting a replayed token is only
 * correct if the token is also left untouched. A mock that answers *any*
 * androidpublisher URL would happily absorb a consume call and let a
 * mis-positioned guard pass, so side-effect URLs are captured separately.
 */
let sideEffectCalls: string[] = [];

/** Google answers "completed, already consumed" for the product lookup. */
function mockConsumedToken(overrides: Record<string, unknown> = {}) {
  const productPurchase = {
    purchaseState: 0,
    consumptionState: 1,
    purchaseTimeMillis: String(Date.now()),
    orderId: ORDER_ID,
    ...overrides,
  };

  vi.spyOn(global, 'fetch').mockImplementation(async (url) => {
    const raw = String(typeof url === 'string' ? url : (url as Request).url ?? url);
    const host = urlHost(url);
    if (host === 'oauth2.googleapis.com') {
      return {
        ok: true,
        json: async () => ({ access_token: 'test_access_token', expires_in: 3600 }),
        text: async () => '',
      } as Response;
    }
    if (host === 'androidpublisher.googleapis.com') {
      if (raw.includes(':consume') || raw.includes(':acknowledge')) {
        sideEffectCalls.push(raw.includes(':consume') ? 'consume' : 'acknowledge');
        return { ok: true, json: async () => ({}), text: async () => '' } as Response;
      }
      return {
        ok: true,
        json: async () => productPurchase,
        text: async () => JSON.stringify(productPurchase),
      } as Response;
    }
    throw new Error(`[test] Unexpected fetch URL: ${raw}`);
  });
}

/** Lets the fire-and-forget consume/acknowledge calls land before we assert. */
async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function recordedPurchase(userId: string): PurchaseInfo {
  return {
    userId,
    productId: PRODUCT_ID,
    platform: 'google',
    type: 'consumable',
    transactionId: ORDER_ID,
    purchasedAt: new Date().toISOString(),
    quantity: 1,
  };
}

function buildApp(purchaseStore: InMemoryPurchaseStore) {
  const app = express();
  app.use(
    createOneSubMiddleware({
      database: { url: '' },
      google: googleConfig(),
      store: new InMemorySubscriptionStore(),
      purchaseStore,
    }),
  );
  return app;
}

function validate(app: express.Express, userId: string) {
  return request(app)
    .post('/onesub/purchase/validate')
    .send({
      platform: 'google',
      receipt: 'purchase_token_abc',
      userId,
      productId: PRODUCT_ID,
      type: 'consumable',
    });
}

describe('already-consumed Google consumable', () => {
  beforeEach(() => {
    sideEffectCalls = [];
    mockConsumedToken();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('restores a purchase already recorded for the same user', async () => {
    const purchaseStore = new InMemoryPurchaseStore();
    await purchaseStore.savePurchase(recordedPurchase('player-1'));

    const res = await validate(buildApp(purchaseStore), 'player-1');

    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(true);
    expect(res.body.action).toBe('restored');
    // The client makes fulfillment idempotent off this id, so it has to survive.
    expect(res.body.purchase.transactionId).toBe(ORDER_ID);
  });

  it('refuses to hand a recorded consumable to a different user', async () => {
    const purchaseStore = new InMemoryPurchaseStore();
    await purchaseStore.savePurchase(recordedPurchase('player-1'));

    const res = await validate(buildApp(purchaseStore), 'player-2');

    expect(res.status).toBe(409);
    expect(res.body.errorCode).toBe('TRANSACTION_BELONGS_TO_OTHER_USER');
  });

  // The one case that is genuinely suspicious: something consumed this token and
  // it was not us.
  //
  // Asserting the 422 alone is not enough — that would still pass if the guard
  // were moved below savePurchase or below the consume call, which is exactly the
  // regression this whole change could introduce. So assert what must NOT have
  // happened too: no row written, no token touched.
  it('rejects a consumed token it has no record of, without writing or consuming', async () => {
    const purchaseStore = new InMemoryPurchaseStore();

    const res = await validate(buildApp(purchaseStore), 'player-1');
    await settle();

    expect(res.status).toBe(422);
    expect(res.body.errorCode).toBe('RECEIPT_VALIDATION_FAILED');
    expect(res.body.valid).toBe(false);

    expect(await purchaseStore.getPurchaseByTransactionId(ORDER_ID)).toBeFalsy();
    expect(await purchaseStore.getPurchasesByUserId('player-1')).toEqual([]);
    expect(sideEffectCalls).toEqual([]);
  });

  // A restore is a read. It must not re-consume a token Google already consumed.
  it('does not re-consume when restoring a recorded purchase', async () => {
    const purchaseStore = new InMemoryPurchaseStore();
    await purchaseStore.savePurchase(recordedPurchase('player-1'));

    const res = await validate(buildApp(purchaseStore), 'player-1');
    await settle();

    expect(res.status).toBe(200);
    expect(sideEffectCalls).toEqual([]);
    // Still exactly one row — a restore must not duplicate the purchase.
    expect(await purchaseStore.getPurchasesByUserId('player-1')).toHaveLength(1);
  });

  // The Unity client infers "was this a verdict about the receipt?" from the
  // status code, and every response has to stay parseable as an onesub result.
  it('keeps every response shape the shipped client can read', async () => {
    const purchaseStore = new InMemoryPurchaseStore();
    await purchaseStore.savePurchase(recordedPurchase('player-1'));

    const restored = await validate(buildApp(purchaseStore), 'player-1');
    expect(restored.body).toHaveProperty('valid');

    const replay = await validate(buildApp(new InMemoryPurchaseStore()), 'player-1');
    expect(replay.body).toHaveProperty('valid', false);
    expect(replay.body).toHaveProperty('error');
    expect(replay.body).toHaveProperty('errorCode');
    // Never 401/403/408/429 from onesub itself: the client treats that class as
    // "we never heard a verdict" and keeps the order pending.
    expect([401, 403, 408, 429]).not.toContain(replay.status);
  });

  // Non-consumables legitimately report consumptionState=1 after acknowledgement.
  // The new flag is scoped to consumables, so their path must be untouched.
  it('leaves non-consumables alone', async () => {
    const purchaseStore = new InMemoryPurchaseStore();

    const res = await request(buildApp(purchaseStore))
      .post('/onesub/purchase/validate')
      .send({
        platform: 'google',
        receipt: 'purchase_token_abc',
        userId: 'player-1',
        productId: 'premium_unlock',
        type: 'non_consumable',
      });
    await settle();

    // Accepted as a fresh purchase, and acknowledged rather than consumed.
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(true);
    expect(await purchaseStore.getPurchaseByTransactionId(ORDER_ID)).toBeTruthy();
    expect(sideEffectCalls).toEqual(['acknowledge']);
  });

  it('still rejects a consumed token whose purchase was canceled', async () => {
    vi.restoreAllMocks();
    mockConsumedToken({ purchaseState: 1 });

    const purchaseStore = new InMemoryPurchaseStore();
    await purchaseStore.savePurchase(recordedPurchase('player-1'));

    const res = await validate(buildApp(purchaseStore), 'player-1');

    expect(res.status).toBe(422);
  });
});
