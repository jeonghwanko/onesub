/**
 * Runs the full-middleware flows (see `full-flow.ts`) on the stores that need no
 * external service. Postgres runs the same flows from `postgres-store.test.ts`.
 */

import IORedisMock from 'ioredis-mock';
import type { Redis } from 'ioredis';
import { InMemoryPurchaseStore, InMemorySubscriptionStore } from '../store.js';
import { RedisPurchaseStore, RedisSubscriptionStore } from '../stores/redis.js';
import { describeFullFlow } from './full-flow.js';

describeFullFlow({
  name: 'in-memory',
  async setup() {},
  async reset() {
    return { subs: new InMemorySubscriptionStore(), purchases: new InMemoryPurchaseStore() };
  },
  async teardown() {},
});

let redis: Redis | undefined;
describeFullFlow({
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
