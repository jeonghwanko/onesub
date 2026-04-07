import { describe, it, expect, beforeEach } from 'vitest';
import { InMemorySubscriptionStore, InMemoryPurchaseStore } from '../store.js';
import type { SubscriptionInfo, PurchaseInfo } from '@onesub/shared';

const makeSub = (overrides?: Partial<SubscriptionInfo>): SubscriptionInfo => ({
  userId: 'user_123',
  productId: 'com.example.pro_monthly',
  platform: 'apple',
  status: 'active',
  expiresAt: '2025-12-31T00:00:00.000Z',
  originalTransactionId: 'txn_abc123',
  purchasedAt: '2025-01-01T00:00:00.000Z',
  willRenew: true,
  ...overrides,
});

describe('InMemorySubscriptionStore', () => {
  let store: InMemorySubscriptionStore;

  beforeEach(() => {
    store = new InMemorySubscriptionStore();
  });

  it('save() and getByUserId() returns the correct subscription', async () => {
    const sub = makeSub();
    await store.save(sub);

    const result = await store.getByUserId('user_123');
    expect(result).toEqual(sub);
  });

  it('save() and getByTransactionId() returns the correct subscription', async () => {
    const sub = makeSub();
    await store.save(sub);

    const result = await store.getByTransactionId('txn_abc123');
    expect(result).toEqual(sub);
  });

  it('getByUserId() returns null for an unknown user', async () => {
    const result = await store.getByUserId('nonexistent_user');
    expect(result).toBeNull();
  });

  it('getByTransactionId() returns null for an unknown transaction', async () => {
    const result = await store.getByTransactionId('nonexistent_txn');
    expect(result).toBeNull();
  });

  it('save() overwrites an existing subscription for the same userId', async () => {
    const original = makeSub({ status: 'active', expiresAt: '2025-06-01T00:00:00.000Z' });
    await store.save(original);

    const updated = makeSub({
      status: 'expired',
      expiresAt: '2025-01-15T00:00:00.000Z',
      originalTransactionId: 'txn_abc123',
    });
    await store.save(updated);

    const result = await store.getByUserId('user_123');
    expect(result?.status).toBe('expired');
    expect(result?.expiresAt).toBe('2025-01-15T00:00:00.000Z');
  });

  it('save() overwrites an existing subscription indexed by the same transactionId', async () => {
    const original = makeSub({ willRenew: true });
    await store.save(original);

    const updated = makeSub({ willRenew: false, originalTransactionId: 'txn_abc123' });
    await store.save(updated);

    const result = await store.getByTransactionId('txn_abc123');
    expect(result?.willRenew).toBe(false);
  });

  it('stores multiple subscriptions independently', async () => {
    const sub1 = makeSub({ userId: 'user_1', originalTransactionId: 'txn_1' });
    const sub2 = makeSub({ userId: 'user_2', originalTransactionId: 'txn_2', platform: 'google' });
    await store.save(sub1);
    await store.save(sub2);

    expect(await store.getByUserId('user_1')).toEqual(sub1);
    expect(await store.getByUserId('user_2')).toEqual(sub2);
    expect(await store.getByTransactionId('txn_1')).toEqual(sub1);
    expect(await store.getByTransactionId('txn_2')).toEqual(sub2);
  });
});

// ── InMemoryPurchaseStore ────────────────────────────────────────────────────

const makePurchase = (overrides?: Partial<PurchaseInfo>): PurchaseInfo => ({
  userId: 'user_1',
  productId: 'credits_10',
  platform: 'apple',
  type: 'consumable',
  transactionId: 'txn_p1',
  purchasedAt: '2026-01-01T00:00:00.000Z',
  quantity: 1,
  ...overrides,
});

describe('InMemoryPurchaseStore', () => {
  let purchaseStore: InMemoryPurchaseStore;

  beforeEach(() => {
    purchaseStore = new InMemoryPurchaseStore();
  });

  it('savePurchase + getPurchasesByUserId returns purchases', async () => {
    const p = makePurchase();
    await purchaseStore.savePurchase(p);

    const results = await purchaseStore.getPurchasesByUserId('user_1');
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual(p);
  });

  it('getPurchaseByTransactionId returns the correct purchase', async () => {
    const p = makePurchase();
    await purchaseStore.savePurchase(p);

    expect(await purchaseStore.getPurchaseByTransactionId('txn_p1')).toEqual(p);
    expect(await purchaseStore.getPurchaseByTransactionId('unknown')).toBeNull();
  });

  it('hasPurchased returns true for existing purchase', async () => {
    await purchaseStore.savePurchase(makePurchase({ type: 'non_consumable', productId: 'premium_unlock' }));

    expect(await purchaseStore.hasPurchased('user_1', 'premium_unlock')).toBe(true);
    expect(await purchaseStore.hasPurchased('user_1', 'other_product')).toBe(false);
    expect(await purchaseStore.hasPurchased('user_2', 'premium_unlock')).toBe(false);
  });

  it('stores multiple consumable purchases for same user+product', async () => {
    await purchaseStore.savePurchase(makePurchase({ transactionId: 'txn_1' }));
    await purchaseStore.savePurchase(makePurchase({ transactionId: 'txn_2' }));
    await purchaseStore.savePurchase(makePurchase({ transactionId: 'txn_3' }));

    const results = await purchaseStore.getPurchasesByUserId('user_1');
    expect(results).toHaveLength(3);
  });

  it('getPurchasesByUserId returns empty for unknown user', async () => {
    expect(await purchaseStore.getPurchasesByUserId('unknown')).toEqual([]);
  });

  it('stores purchases for different users independently', async () => {
    await purchaseStore.savePurchase(makePurchase({ userId: 'a', transactionId: 't1' }));
    await purchaseStore.savePurchase(makePurchase({ userId: 'b', transactionId: 't2' }));

    expect(await purchaseStore.getPurchasesByUserId('a')).toHaveLength(1);
    expect(await purchaseStore.getPurchasesByUserId('b')).toHaveLength(1);
  });
});
