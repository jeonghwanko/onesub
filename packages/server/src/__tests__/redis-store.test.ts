import { describe, expect, it, beforeEach } from 'vitest';
import IORedisMock from 'ioredis-mock';
import type { Redis } from 'ioredis';
import { RedisSubscriptionStore, RedisPurchaseStore, RedisCacheAdapter, RedisWebhookEventStore } from '../stores/redis.js';
import { SUBSCRIPTION_STATUS } from '@onesub/shared';
import type { SubscriptionInfo, PurchaseInfo } from '@onesub/shared';

async function makeRedis(): Promise<Redis> {
  // ioredis-mock's surface matches ioredis enough for our store's methods
  // (set/get/zadd/zrevrange/sadd/smembers/multi). Cast to keep TS happy.
  // The mock keeps a process-wide store across instances by default — flush
  // so each test starts from a clean slate.
  const r = new IORedisMock() as unknown as Redis;
  await r.flushall();
  return r;
}

const baseSub: SubscriptionInfo = {
  originalTransactionId: 'tx-1',
  userId: 'alice',
  productId: 'pro_monthly',
  platform: 'apple',
  status: SUBSCRIPTION_STATUS.ACTIVE,
  expiresAt: '2030-01-01T00:00:00.000Z',
  purchasedAt: '2025-01-01T00:00:00.000Z',
  willRenew: true,
};

describe('RedisSubscriptionStore', () => {
  let redis: Redis;
  let store: RedisSubscriptionStore;

  beforeEach(async () => {
    redis = await makeRedis();
    store = new RedisSubscriptionStore(redis);
  });

  it('save + getByTransactionId round-trip', async () => {
    await store.save(baseSub);
    const fetched = await store.getByTransactionId('tx-1');
    expect(fetched).toEqual(baseSub);
  });

  it('getByUserId returns the most-recent record', async () => {
    await store.save({ ...baseSub, originalTransactionId: 'tx-1', expiresAt: '2026-01-01T00:00:00.000Z' });
    // Force a 1ms gap so the second save lands with a higher zadd score.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await store.save({ ...baseSub, originalTransactionId: 'tx-2', expiresAt: '2027-01-01T00:00:00.000Z' });
    const latest = await store.getByUserId('alice');
    expect(latest?.originalTransactionId).toBe('tx-2');
  });

  it('getAllByUserId returns every tx newest-first', async () => {
    await store.save({ ...baseSub, originalTransactionId: 'tx-1' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await store.save({ ...baseSub, originalTransactionId: 'tx-2' });
    const all = await store.getAllByUserId('alice');
    expect(all.map((s) => s.originalTransactionId)).toEqual(['tx-2', 'tx-1']);
  });

  it('listAll surfaces subs across users', async () => {
    await store.save({ ...baseSub, originalTransactionId: 'tx-a', userId: 'alice' });
    await store.save({ ...baseSub, originalTransactionId: 'tx-b', userId: 'bob' });
    const all = await store.listAll();
    expect(all).toHaveLength(2);
  });

  it('listFiltered respects userId + status filters', async () => {
    await store.save({ ...baseSub, originalTransactionId: 'tx-a', userId: 'alice' });
    await store.save({ ...baseSub, originalTransactionId: 'tx-b', userId: 'alice', status: SUBSCRIPTION_STATUS.EXPIRED });
    const result = await store.listFiltered({ userId: 'alice', status: SUBSCRIPTION_STATUS.ACTIVE });
    expect(result.total).toBe(1);
    expect(result.items[0].originalTransactionId).toBe('tx-a');
  });

  it('listFiltered pure pagination fast path returns correct total + page', async () => {
    for (let i = 0; i < 5; i++) {
      await store.save({ ...baseSub, originalTransactionId: `tx-p${i}`, userId: `user${i}` });
    }
    const page1 = await store.listFiltered({ limit: 2, offset: 0 });
    expect(page1.total).toBe(5);
    expect(page1.items).toHaveLength(2);

    const page2 = await store.listFiltered({ limit: 2, offset: 2 });
    expect(page2.total).toBe(5);
    expect(page2.items).toHaveLength(2);

    // pages should not overlap
    const ids1 = page1.items.map((s) => s.originalTransactionId);
    const ids2 = page2.items.map((s) => s.originalTransactionId);
    expect(ids1.filter((id) => ids2.includes(id))).toHaveLength(0);
  });

  it('listAll returns items newest-first', async () => {
    await store.save({ ...baseSub, originalTransactionId: 'tx-old' });
    await new Promise((r) => setTimeout(r, 5));
    await store.save({ ...baseSub, originalTransactionId: 'tx-new' });
    const all = await store.listAll();
    expect(all[0].originalTransactionId).toBe('tx-new');
    expect(all[1].originalTransactionId).toBe('tx-old');
  });
});

const basePurchase: PurchaseInfo = {
  transactionId: 'p-1',
  userId: 'alice',
  productId: 'remove_ads',
  platform: 'apple',
  type: 'non_consumable',
  quantity: 1,
  purchasedAt: '2025-01-01T00:00:00.000Z',
};

describe('RedisPurchaseStore', () => {
  let redis: Redis;
  let store: RedisPurchaseStore;

  beforeEach(async () => {
    redis = await makeRedis();
    store = new RedisPurchaseStore(redis);
  });

  it('savePurchase + getPurchaseByTransactionId round-trip', async () => {
    await store.savePurchase(basePurchase);
    const fetched = await store.getPurchaseByTransactionId('p-1');
    expect(fetched).toEqual(basePurchase);
  });

  it('refuses cross-user reuse of the same transactionId', async () => {
    await store.savePurchase(basePurchase);
    await expect(store.savePurchase({ ...basePurchase, userId: 'mallory' })).rejects.toThrow(
      /TRANSACTION_BELONGS_TO_OTHER_USER/,
    );
  });

  it('hasPurchased detects a non-consumable buy', async () => {
    await store.savePurchase(basePurchase);
    expect(await store.hasPurchased('alice', 'remove_ads')).toBe(true);
    expect(await store.hasPurchased('alice', 'other_product')).toBe(false);
  });

  it('reassignPurchase moves ownership without losing the row', async () => {
    await store.savePurchase(basePurchase);
    expect(await store.reassignPurchase('p-1', 'bob')).toBe(true);
    const fetched = await store.getPurchaseByTransactionId('p-1');
    expect(fetched?.userId).toBe('bob');
    expect(await store.hasPurchased('alice', 'remove_ads')).toBe(false);
    expect(await store.hasPurchased('bob', 'remove_ads')).toBe(true);
  });

  it('deletePurchaseByTransactionId removes everywhere', async () => {
    await store.savePurchase(basePurchase);
    expect(await store.deletePurchaseByTransactionId('p-1')).toBe(true);
    expect(await store.getPurchaseByTransactionId('p-1')).toBeNull();
    expect(await store.hasPurchased('alice', 'remove_ads')).toBe(false);
  });
});

describe('RedisCacheAdapter', () => {
  it('round-trips with TTL', async () => {
    const cache = new RedisCacheAdapter(await makeRedis());
    await cache.set('k', { token: 'abc' }, 60);
    expect(await cache.get('k')).toEqual({ token: 'abc' });
  });

  it('returns null for missing keys', async () => {
    const cache = new RedisCacheAdapter(await makeRedis());
    expect(await cache.get('absent')).toBeNull();
  });
});

describe('RedisWebhookEventStore', () => {
  it('returns true on first sighting', async () => {
    const store = new RedisWebhookEventStore(await makeRedis());
    expect(await store.markIfNew('apple', 'uuid-1')).toBe(true);
  });

  it('returns false on duplicate (atomic SET NX)', async () => {
    const store = new RedisWebhookEventStore(await makeRedis());
    expect(await store.markIfNew('apple', 'uuid-1')).toBe(true);
    expect(await store.markIfNew('apple', 'uuid-1')).toBe(false);
  });

  it('namespaces apple vs google so the same id does not collide', async () => {
    const store = new RedisWebhookEventStore(await makeRedis());
    expect(await store.markIfNew('apple', 'shared-id')).toBe(true);
    expect(await store.markIfNew('google', 'shared-id')).toBe(true);
  });

  it('different event ids are independent', async () => {
    const store = new RedisWebhookEventStore(await makeRedis());
    expect(await store.markIfNew('google', 'msg-1')).toBe(true);
    expect(await store.markIfNew('google', 'msg-2')).toBe(true);
    expect(await store.markIfNew('google', 'msg-1')).toBe(false);
  });
});
