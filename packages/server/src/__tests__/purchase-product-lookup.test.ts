/**
 * Product-scoped purchase lookup — `PurchaseStore.getPurchasesForProduct`.
 *
 * Non-consumable validation used to read a user's entire purchase history and
 * filter it in process, so an account with a long consumable history paid for
 * every one of those rows on each lifetime-product purchase. The optional
 * store method pushes the filter into an index instead.
 *
 * Covered here:
 *   - the store contract, including the most-recent-first ordering all three
 *     built-in stores must agree on
 *   - that the route actually uses the index-backed method when a store has one
 *     (responses are identical either way, so only a call count shows it)
 *   - that a store without the method still works, since it is optional
 */

import { describe, it, expect } from 'vitest';
import request from 'supertest';
import express from 'express';
import type { PurchaseInfo } from '@onesub/shared';
import { createOneSubMiddleware } from '../index.js';
import { InMemorySubscriptionStore, InMemoryPurchaseStore } from '../store.js';
import type { PurchaseStore } from '../store.js';

function purchase(overrides?: Partial<PurchaseInfo>): PurchaseInfo {
  return {
    userId: 'u',
    productId: 'coins_100',
    platform: 'apple',
    type: 'consumable',
    transactionId: `tx_${Math.random()}`,
    purchasedAt: '2026-04-10T00:00:00.000Z',
    quantity: 1,
    ...overrides,
  };
}

/** Counts calls to one method while leaving its behaviour intact. */
function countCalls<T extends object, K extends keyof T>(target: T, method: K): () => number {
  let calls = 0;
  const original = target[method] as unknown as (...args: unknown[]) => unknown;
  (target as Record<K, unknown>)[method] = (...args: unknown[]) => {
    calls++;
    return original.apply(target, args);
  };
  return () => calls;
}

/**
 * A store that deliberately does NOT implement `getPurchasesForProduct`, standing
 * in for a host's own `PurchaseStore` written before the method existed.
 */
function storeWithoutProductLookup(): PurchaseStore {
  const inner = new InMemoryPurchaseStore();
  const shim: PurchaseStore = {
    savePurchase: (p) => inner.savePurchase(p),
    getPurchasesByUserId: (u) => inner.getPurchasesByUserId(u),
    getPurchaseByTransactionId: (t) => inner.getPurchaseByTransactionId(t),
    listAll: () => inner.listAll(),
    hasPurchased: (u, p) => inner.hasPurchased(u, p),
    deletePurchases: (u, p) => inner.deletePurchases(u, p),
    deletePurchaseByTransactionId: (t) => inner.deletePurchaseByTransactionId(t),
    reassignPurchase: (t, u) => inner.reassignPurchase(t, u),
  };
  return shim;
}

function buildApp(purchaseStore: PurchaseStore) {
  const app = express();
  app.use(
    createOneSubMiddleware({
      database: { url: '' },
      apple: { bundleId: 'com.test.mock', mockMode: true },
      google: { packageName: 'com.test.mock', mockMode: true },
      store: new InMemorySubscriptionStore(),
      purchaseStore,
    }),
  );
  return app;
}

describe('InMemoryPurchaseStore.getPurchasesForProduct', () => {
  it('returns only the requested product', async () => {
    const store = new InMemoryPurchaseStore();
    await store.savePurchase(purchase({ userId: 'a', productId: 'coins_100', transactionId: 't1' }));
    await store.savePurchase(purchase({ userId: 'a', productId: 'coins_100', transactionId: 't2' }));
    await store.savePurchase(purchase({ userId: 'a', productId: 'lifetime_pass', transactionId: 't3' }));
    // Another user's row for the same product must not leak.
    await store.savePurchase(purchase({ userId: 'b', productId: 'coins_100', transactionId: 't4' }));

    const rows = await store.getPurchasesForProduct('a', 'coins_100');
    expect(rows).toHaveLength(2);
    expect(rows.every((p) => p.productId === 'coins_100' && p.userId === 'a')).toBe(true);
  });

  it('returns an empty array for an unknown user or product', async () => {
    const store = new InMemoryPurchaseStore();
    await store.savePurchase(purchase({ userId: 'a', productId: 'coins_100' }));
    expect(await store.getPurchasesForProduct('a', 'nothing')).toEqual([]);
    expect(await store.getPurchasesForProduct('nobody', 'coins_100')).toEqual([]);
  });
});

describe('InMemoryPurchaseStore ordering', () => {
  // Postgres orders `purchased_at DESC` and Redis reads a reverse-scored set, so
  // the in-memory store has to agree or `/onesub/purchase/status` returns a
  // different order under `onesub dev` than in production for the same data.
  it('returns purchases most-recent-first regardless of insertion order', async () => {
    const store = new InMemoryPurchaseStore();
    await store.savePurchase(purchase({ userId: 'a', purchasedAt: '2026-04-10T00:00:00Z', transactionId: 'mid' }));
    await store.savePurchase(purchase({ userId: 'a', purchasedAt: '2026-01-01T00:00:00Z', transactionId: 'oldest' }));
    await store.savePurchase(purchase({ userId: 'a', purchasedAt: '2026-08-01T00:00:00Z', transactionId: 'newest' }));

    expect((await store.getPurchasesByUserId('a')).map((p) => p.transactionId)).toEqual([
      'newest',
      'mid',
      'oldest',
    ]);
  });

  it('applies the same ordering to the product-scoped lookup', async () => {
    const store = new InMemoryPurchaseStore();
    await store.savePurchase(purchase({ userId: 'a', purchasedAt: '2026-04-10T00:00:00Z', transactionId: 'mid' }));
    await store.savePurchase(purchase({ userId: 'a', purchasedAt: '2026-08-01T00:00:00Z', transactionId: 'newest' }));
    await store.savePurchase(purchase({ userId: 'a', purchasedAt: '2026-01-01T00:00:00Z', transactionId: 'oldest' }));

    expect((await store.getPurchasesForProduct('a', 'coins_100')).map((p) => p.transactionId)).toEqual([
      'newest',
      'mid',
      'oldest',
    ]);
  });

  it('does not hand out a reference to its own list', async () => {
    const store = new InMemoryPurchaseStore();
    await store.savePurchase(purchase({ userId: 'a', transactionId: 't1' }));

    const first = await store.getPurchasesByUserId('a');
    first.push(purchase({ userId: 'a', transactionId: 'injected' }));

    expect(await store.getPurchasesByUserId('a')).toHaveLength(1);
  });
});

describe('non-consumable validation uses the index-backed lookup', () => {
  it('does not read the user’s whole purchase history', async () => {
    const purchaseStore = new InMemoryPurchaseStore();
    // A consumable-heavy account: these rows are irrelevant to owning `premium`
    // and must not be transferred to answer the ownership question.
    for (let i = 0; i < 20; i++) {
      await purchaseStore.savePurchase(
        purchase({ userId: 'user_1', productId: 'coins_100', transactionId: `coin_${i}` }),
      );
    }
    const app = buildApp(purchaseStore);
    const fullReads = countCalls(purchaseStore, 'getPurchasesByUserId');
    const scopedReads = countCalls(purchaseStore, 'getPurchasesForProduct');

    const res = await request(app).post('/onesub/purchase/validate').send({
      platform: 'apple',
      receipt: 'MOCK_VALID_p4_first',
      userId: 'user_1',
      productId: 'premium',
      type: 'non_consumable',
    });

    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(true);
    expect(scopedReads()).toBe(1);
    expect(fullReads()).toBe(0);
  });

  it('still reports an owned non-consumable as a restore', async () => {
    const purchaseStore = new InMemoryPurchaseStore();
    const app = buildApp(purchaseStore);
    const body = {
      platform: 'apple',
      receipt: 'MOCK_VALID_p4_owned',
      userId: 'user_1',
      productId: 'premium',
      type: 'non_consumable',
    };

    const first = await request(app).post('/onesub/purchase/validate').send(body);
    expect(first.body.action).toBe('new');

    // Second call with a DIFFERENT receipt for the same product — the ownership
    // check, not transactionId dedup, is what has to catch this.
    const second = await request(app)
      .post('/onesub/purchase/validate')
      .send({ ...body, receipt: 'MOCK_VALID_p4_owned_again' });

    expect(second.status).toBe(200);
    expect(second.body.valid).toBe(true);
    expect(second.body.action).toBe('restored');
    expect(second.body.purchase.transactionId).toBe(first.body.purchase.transactionId);
  });
});

describe('a store without getPurchasesForProduct still works', () => {
  it('falls back to reading the full history and filtering', async () => {
    const purchaseStore = storeWithoutProductLookup();
    expect(purchaseStore.getPurchasesForProduct).toBeUndefined();
    const app = buildApp(purchaseStore);
    const fullReads = countCalls(purchaseStore, 'getPurchasesByUserId');

    const first = await request(app).post('/onesub/purchase/validate').send({
      platform: 'apple',
      receipt: 'MOCK_VALID_p4_fallback',
      userId: 'user_1',
      productId: 'premium',
      type: 'non_consumable',
    });
    expect(first.status).toBe(200);
    expect(first.body.action).toBe('new');

    const second = await request(app).post('/onesub/purchase/validate').send({
      platform: 'apple',
      receipt: 'MOCK_VALID_p4_fallback_2',
      userId: 'user_1',
      productId: 'premium',
      type: 'non_consumable',
    });
    expect(second.body.action).toBe('restored');

    // The fallback is the whole point: it must have used the unscoped read.
    expect(fullReads()).toBeGreaterThan(0);
  });

  it('serves GET /onesub/purchase/status?productId= through the fallback', async () => {
    const purchaseStore = storeWithoutProductLookup();
    await purchaseStore.savePurchase(purchase({ userId: 'a', productId: 'coins_100', transactionId: 'c1' }));
    await purchaseStore.savePurchase(purchase({ userId: 'a', productId: 'lifetime_pass', transactionId: 'l1' }));
    const app = buildApp(purchaseStore);

    const res = await request(app).get('/onesub/purchase/status?userId=a&productId=coins_100');
    expect(res.status).toBe(200);
    expect(res.body.purchases).toHaveLength(1);
    expect(res.body.purchases[0].productId).toBe('coins_100');
  });
});

describe('GET /onesub/purchase/status', () => {
  it('scopes to the store when productId is given', async () => {
    const purchaseStore = new InMemoryPurchaseStore();
    await purchaseStore.savePurchase(purchase({ userId: 'a', productId: 'coins_100', transactionId: 'c1' }));
    await purchaseStore.savePurchase(purchase({ userId: 'a', productId: 'coins_100', transactionId: 'c2' }));
    await purchaseStore.savePurchase(purchase({ userId: 'a', productId: 'lifetime_pass', transactionId: 'l1' }));
    const app = buildApp(purchaseStore);
    const fullReads = countCalls(purchaseStore, 'getPurchasesByUserId');

    const res = await request(app).get('/onesub/purchase/status?userId=a&productId=coins_100');

    expect(res.status).toBe(200);
    expect(res.body.purchases).toHaveLength(2);
    expect(res.body.purchases.every((p: PurchaseInfo) => p.productId === 'coins_100')).toBe(true);
    expect(fullReads()).toBe(0);
  });

  it('returns the full history when no productId is given', async () => {
    const purchaseStore = new InMemoryPurchaseStore();
    await purchaseStore.savePurchase(purchase({ userId: 'a', productId: 'coins_100', transactionId: 'c1' }));
    await purchaseStore.savePurchase(purchase({ userId: 'a', productId: 'lifetime_pass', transactionId: 'l1' }));
    const app = buildApp(purchaseStore);

    const res = await request(app).get('/onesub/purchase/status?userId=a');

    expect(res.status).toBe(200);
    expect(res.body.purchases).toHaveLength(2);
  });

  it('does not leak another user’s purchases', async () => {
    const purchaseStore = new InMemoryPurchaseStore();
    await purchaseStore.savePurchase(purchase({ userId: 'a', productId: 'coins_100', transactionId: 'c1' }));
    await purchaseStore.savePurchase(purchase({ userId: 'b', productId: 'coins_100', transactionId: 'c2' }));
    const app = buildApp(purchaseStore);

    const res = await request(app).get('/onesub/purchase/status?userId=a&productId=coins_100');
    expect(res.body.purchases).toHaveLength(1);
    expect(res.body.purchases[0].transactionId).toBe('c1');
  });
});
