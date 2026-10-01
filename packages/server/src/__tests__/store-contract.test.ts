/**
 * Runs the shared store contract (see `store-contract.ts`) against the stores
 * that need no external service. Postgres runs the same contract from
 * `postgres-store.test.ts`.
 */

import IORedisMock from 'ioredis-mock';
import type { Redis } from 'ioredis';
import { InMemoryPurchaseStore, InMemorySubscriptionStore } from '../store.js';
import { RedisPurchaseStore, RedisSubscriptionStore } from '../stores/redis.js';
import { describeStoreContract } from './store-contract.js';

describeStoreContract({
  name: 'in-memory',
  async setup() {},
  async reset() {
    return { subs: new InMemorySubscriptionStore(), purchases: new InMemoryPurchaseStore() };
  },
  async teardown() {},
});

// ioredis-mock: MULTI semantics the mock implements differently from real
// Redis are out of reach here.
let redis: Redis | undefined;
describeStoreContract({
  name: 'redis (ioredis-mock)',
  async setup() {
    redis = new IORedisMock() as unknown as Redis;
  },
  async reset() {
    await redis!.flushall();
    return { subs: new RedisSubscriptionStore(redis!), purchases: new RedisPurchaseStore(redis!) };
  },
  async teardown() {
    redis?.disconnect();
  },
});
