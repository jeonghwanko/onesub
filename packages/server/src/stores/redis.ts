import type { SubscriptionInfo, PurchaseInfo } from '@onesub/shared';
import type {
  SubscriptionStore,
  PurchaseStore,
  ListFilteredOptions,
  ListFilteredResult,
} from '../store.js';
import type { CacheAdapter } from '../cache.js';

type IORedis = import('ioredis').Redis;

/**
 * Redis-backed subscription / purchase / cache stores.
 *
 * Uses the `ioredis` package — kept as an optional peer dependency so callers
 * who only need InMemory or Postgres pay no install cost.
 *
 *   npm install ioredis
 *
 * Usage:
 *   import Redis from 'ioredis';
 *   import {
 *     RedisSubscriptionStore,
 *     RedisPurchaseStore,
 *     RedisCacheAdapter,
 *   } from '@onesub/server';
 *
 *   const redis = new Redis(process.env.REDIS_URL!);
 *   const store = new RedisSubscriptionStore(redis);
 *   const purchaseStore = new RedisPurchaseStore(redis);
 *   const cache = new RedisCacheAdapter(redis);
 *
 *   app.use(createOneSubMiddleware({ ...config, store, purchaseStore, cache }));
 *
 * Key layout:
 *   onesub:sub:tx:<originalTransactionId>      → JSON SubscriptionInfo
 *   onesub:sub:user:<userId>                   → SortedSet of originalTransactionIds, scored by updatedAt (ms)
 *   onesub:sub:all                             → Set of originalTransactionIds (for listAll/listFiltered)
 *   onesub:purchase:tx:<transactionId>         → JSON PurchaseInfo
 *   onesub:purchase:user:<userId>              → SortedSet of transactionIds, scored by purchasedAt (ms)
 *   onesub:purchase:user_product:<u>:<p>       → Set of transactionIds (for non-consumable hasPurchased)
 *   onesub:purchase:all                        → Set of transactionIds
 *   onesub:cache:<key>                         → string with TTL (RedisCacheAdapter)
 *   onesub:webhook:event:<provider>:<id>       → "1" with TTL (RedisWebhookEventStore)
 */

const SUB_TX_PREFIX = 'onesub:sub:tx:';
const SUB_USER_PREFIX = 'onesub:sub:user:';
const SUB_ALL = 'onesub:sub:all';

const PUR_TX_PREFIX = 'onesub:purchase:tx:';
const PUR_USER_PREFIX = 'onesub:purchase:user:';
const PUR_USER_PRODUCT_PREFIX = 'onesub:purchase:user_product:';
const PUR_ALL = 'onesub:purchase:all';

export class RedisSubscriptionStore implements SubscriptionStore {
  constructor(private readonly redis: IORedis) {}

  async save(sub: SubscriptionInfo): Promise<void> {
    const score = Date.now();
    const txKey = SUB_TX_PREFIX + sub.originalTransactionId;
    const userKey = SUB_USER_PREFIX + sub.userId;

    // Multi-key write — use a pipeline so the three commands are at least
    // sent in one round-trip. Atomicity is best-effort; the only consistency
    // hazard is a crash between commands, which leaves the user index without
    // the new tx (recoverable: subsequent writes for the same tx fix it).
    const pipeline = this.redis.multi();
    pipeline.set(txKey, JSON.stringify(sub));
    pipeline.zadd(userKey, score, sub.originalTransactionId);
    pipeline.sadd(SUB_ALL, sub.originalTransactionId);
    await pipeline.exec();
  }

  async getByUserId(userId: string): Promise<SubscriptionInfo | null> {
    const userKey = SUB_USER_PREFIX + userId;
    // ZREVRANGE 0 0 = most-recent (highest score)
    const ids = await this.redis.zrevrange(userKey, 0, 0);
    if (ids.length === 0) return null;
    const raw = await this.redis.get(SUB_TX_PREFIX + ids[0]);
    return raw ? (JSON.parse(raw) as SubscriptionInfo) : null;
  }

  async getAllByUserId(userId: string): Promise<SubscriptionInfo[]> {
    const userKey = SUB_USER_PREFIX + userId;
    const ids = await this.redis.zrevrange(userKey, 0, -1);
    if (ids.length === 0) return [];
    const raws = await this.redis.mget(...ids.map((id) => SUB_TX_PREFIX + id));
    return raws.filter((r): r is string => r != null).map((r) => JSON.parse(r) as SubscriptionInfo);
  }

  async getByTransactionId(txId: string): Promise<SubscriptionInfo | null> {
    const raw = await this.redis.get(SUB_TX_PREFIX + txId);
    return raw ? (JSON.parse(raw) as SubscriptionInfo) : null;
  }

  async listAll(): Promise<SubscriptionInfo[]> {
    const ids = await this.redis.smembers(SUB_ALL);
    if (ids.length === 0) return [];
    const raws = await this.redis.mget(...ids.map((id) => SUB_TX_PREFIX + id));
    return raws.filter((r): r is string => r != null).map((r) => JSON.parse(r) as SubscriptionInfo);
  }

  async listFiltered(opts: ListFilteredOptions): Promise<ListFilteredResult> {
    // Redis has no secondary indexes — for listFiltered we materialise the
    // candidate set then apply filters in-process. Fine for small/medium data;
    // for >100k rows pair this with Postgres or use Redis Stack with RediSearch.
    const limit = opts.limit ?? 50;
    const offset = opts.offset ?? 0;

    let candidates: SubscriptionInfo[];
    if (opts.userId) {
      candidates = await this.getAllByUserId(opts.userId);
    } else {
      candidates = await this.listAll();
      // Sort newest-first by purchasedAt as a stable proxy when no per-user
      // sorted set is available. SubscriptionInfo doesn't carry updatedAt, so
      // we fall back to expiresAt for a "freshest first" ordering.
      candidates.sort((a, b) => Date.parse(b.expiresAt) - Date.parse(a.expiresAt));
    }

    const filtered = candidates.filter((s) => {
      if (opts.status && s.status !== opts.status) return false;
      if (opts.productId && s.productId !== opts.productId) return false;
      if (opts.platform && s.platform !== opts.platform) return false;
      return true;
    });

    return {
      items: filtered.slice(offset, offset + limit),
      total: filtered.length,
      limit,
      offset,
    };
  }
}

export class RedisPurchaseStore implements PurchaseStore {
  constructor(private readonly redis: IORedis) {}

  async savePurchase(purchase: PurchaseInfo): Promise<void> {
    const txKey = PUR_TX_PREFIX + purchase.transactionId;

    // Owner check — same TRANSACTION_BELONGS_TO_OTHER_USER semantics as
    // Postgres / InMemory implementations. Without this guard a stolen
    // receipt could be re-bound to a different account.
    const existing = await this.redis.get(txKey);
    if (existing) {
      const owner = (JSON.parse(existing) as PurchaseInfo).userId;
      if (owner !== purchase.userId) {
        const err = new Error('TRANSACTION_BELONGS_TO_OTHER_USER') as Error & { code?: string };
        err.code = 'TRANSACTION_BELONGS_TO_OTHER_USER';
        throw err;
      }
      return; // idempotent — same user
    }

    const score = Date.parse(purchase.purchasedAt) || Date.now();
    const pipeline = this.redis.multi();
    pipeline.set(txKey, JSON.stringify(purchase));
    pipeline.zadd(PUR_USER_PREFIX + purchase.userId, score, purchase.transactionId);
    pipeline.sadd(PUR_USER_PRODUCT_PREFIX + purchase.userId + ':' + purchase.productId, purchase.transactionId);
    pipeline.sadd(PUR_ALL, purchase.transactionId);
    await pipeline.exec();
  }

  async getPurchasesByUserId(userId: string): Promise<PurchaseInfo[]> {
    const ids = await this.redis.zrevrange(PUR_USER_PREFIX + userId, 0, -1);
    if (ids.length === 0) return [];
    const raws = await this.redis.mget(...ids.map((id) => PUR_TX_PREFIX + id));
    return raws.filter((r): r is string => r != null).map((r) => JSON.parse(r) as PurchaseInfo);
  }

  async getPurchaseByTransactionId(txId: string): Promise<PurchaseInfo | null> {
    const raw = await this.redis.get(PUR_TX_PREFIX + txId);
    return raw ? (JSON.parse(raw) as PurchaseInfo) : null;
  }

  async hasPurchased(userId: string, productId: string): Promise<boolean> {
    const count = await this.redis.scard(PUR_USER_PRODUCT_PREFIX + userId + ':' + productId);
    return count > 0;
  }

  async reassignPurchase(transactionId: string, newUserId: string): Promise<boolean> {
    const txKey = PUR_TX_PREFIX + transactionId;
    const raw = await this.redis.get(txKey);
    if (!raw) return false;
    const existing = JSON.parse(raw) as PurchaseInfo;
    if (existing.userId === newUserId) return true;

    const updated: PurchaseInfo = { ...existing, userId: newUserId };
    const score = Date.parse(updated.purchasedAt) || Date.now();
    const oldUserProductKey = PUR_USER_PRODUCT_PREFIX + existing.userId + ':' + existing.productId;
    const newUserProductKey = PUR_USER_PRODUCT_PREFIX + newUserId + ':' + existing.productId;

    const pipeline = this.redis.multi();
    pipeline.set(txKey, JSON.stringify(updated));
    pipeline.zrem(PUR_USER_PREFIX + existing.userId, transactionId);
    pipeline.zadd(PUR_USER_PREFIX + newUserId, score, transactionId);
    pipeline.srem(oldUserProductKey, transactionId);
    pipeline.sadd(newUserProductKey, transactionId);
    await pipeline.exec();
    return true;
  }

  async deletePurchases(userId: string, productId: string): Promise<number> {
    const userProductKey = PUR_USER_PRODUCT_PREFIX + userId + ':' + productId;
    const ids = await this.redis.smembers(userProductKey);
    if (ids.length === 0) return 0;

    const pipeline = this.redis.multi();
    for (const id of ids) {
      pipeline.del(PUR_TX_PREFIX + id);
      pipeline.zrem(PUR_USER_PREFIX + userId, id);
      pipeline.srem(PUR_ALL, id);
    }
    pipeline.del(userProductKey);
    await pipeline.exec();
    return ids.length;
  }

  async deletePurchaseByTransactionId(transactionId: string): Promise<boolean> {
    const txKey = PUR_TX_PREFIX + transactionId;
    const raw = await this.redis.get(txKey);
    if (!raw) return false;
    const existing = JSON.parse(raw) as PurchaseInfo;

    const pipeline = this.redis.multi();
    pipeline.del(txKey);
    pipeline.zrem(PUR_USER_PREFIX + existing.userId, transactionId);
    pipeline.srem(PUR_USER_PRODUCT_PREFIX + existing.userId + ':' + existing.productId, transactionId);
    pipeline.srem(PUR_ALL, transactionId);
    await pipeline.exec();
    return true;
  }

  async listAll(): Promise<PurchaseInfo[]> {
    const ids = await this.redis.smembers(PUR_ALL);
    if (ids.length === 0) return [];
    const raws = await this.redis.mget(...ids.map((id) => PUR_TX_PREFIX + id));
    return raws.filter((r): r is string => r != null).map((r) => JSON.parse(r) as PurchaseInfo);
  }
}

/**
 * Redis-backed cache adapter — share JWKS / OAuth tokens across cluster nodes.
 *
 * Implements `CacheAdapter` so it plugs into the same default-cache slot used
 * by the Apple JWT minter and Google OAuth token minter.
 */
export class RedisCacheAdapter implements CacheAdapter {
  constructor(
    private readonly redis: IORedis,
    private readonly prefix = 'onesub:cache:',
  ) {}

  async get<T = unknown>(key: string): Promise<T | null> {
    const raw = await this.redis.get(this.prefix + key);
    return raw ? (JSON.parse(raw) as T) : null;
  }

  async set<T = unknown>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    const fullKey = this.prefix + key;
    const payload = JSON.stringify(value);
    if (ttlSeconds && ttlSeconds > 0) {
      await this.redis.set(fullKey, payload, 'EX', ttlSeconds);
    } else {
      await this.redis.set(fullKey, payload);
    }
  }

  async del(key: string): Promise<void> {
    await this.redis.del(this.prefix + key);
  }
}
