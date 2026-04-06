import { describe, it, expect, beforeEach } from 'vitest';
import { InMemorySubscriptionStore } from '../store.js';
import type { SubscriptionInfo } from '@onesub/shared';

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
