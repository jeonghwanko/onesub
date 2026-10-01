import type { SubscriptionInfo, PurchaseInfo } from '@onesub/shared';
import type {
  SubscriptionStore,
  PurchaseStore,
  ListFilteredOptions,
  ListFilteredResult,
} from '../store.js';
import { purchaseConflict } from '../store.js';
import type { CacheAdapter } from '../cache.js';
import type { WebhookEventStore } from '../webhook-events.js';

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
 *   onesub:sub:owner:<originalTransactionId>   → userId (cheap prev-owner lookup in save(); written by the same script as the record)
 *   onesub:sub:asof:<originalTransactionId>    → the record's stateAsOf, compared atomically by save()
 *   onesub:sub:user:<userId>                   → SortedSet of originalTransactionIds, scored by updatedAt (ms)
 *   onesub:sub:all:sorted                      → SortedSet of originalTransactionIds, scored by save time (for listAll/listFiltered)
 *   onesub:purchase:tx:<transactionId>         → JSON PurchaseInfo
 *   onesub:purchase:user:<userId>              → SortedSet of transactionIds, scored by purchasedAt (ms)
 *   onesub:purchase:user_product:<u>:<p>       → Set of transactionIds (for non-consumable hasPurchased)
 *   onesub:purchase:nc:<u>:<p>                 → transactionId holding this user's non-consumable (SET NX claim)
 *   onesub:purchase:all                        → Set of transactionIds
 *   onesub:cache:<key>                         → string with TTL (RedisCacheAdapter)
 *   onesub:webhook:event:<provider>:<id>       → "1" with TTL (RedisWebhookEventStore)
 */

const SUB_TX_PREFIX = 'onesub:sub:tx:';
const SUB_OWNER_PREFIX = 'onesub:sub:owner:';
const SUB_USER_PREFIX = 'onesub:sub:user:';
// Global sorted set (score = save timestamp ms) — enables ordered listAll and
// O(log n + limit) fast-path pagination when no secondary filters are applied.
const SUB_ALL_SORTED = 'onesub:sub:all:sorted';
// Snapshot time of the record (`stateAsOf`) as a plain string, so the save
// script can compare it without decoding JSON.
const SUB_AS_OF_PREFIX = 'onesub:sub:asof:';

/**
 * Upsert a subscription unless the stored snapshot is newer (lifecycle.ts).
 * `stateAsOf` values are all `Date#toISOString()` output — fixed width, UTC — so
 * string order is time order.
 *
 * KEYS: tx record, as-of, owner, new user's set, global set.
 * ARGV: record JSON, stateAsOf ('' = none), userId, score, originalTransactionId,
 *       previous owner for records without an owner key ('' = none), user-set prefix.
 */
const SAVE_SUBSCRIPTION_SCRIPT = `
local asof = ARGV[2]
if asof ~= '' then
  local cur = redis.call('GET', KEYS[2])
  if cur and cur > asof then return 0 end
end
local prev = redis.call('GET', KEYS[3])
if not prev and ARGV[6] ~= '' then prev = ARGV[6] end
redis.call('SET', KEYS[1], ARGV[1])
redis.call('SET', KEYS[3], ARGV[3])
if asof ~= '' then redis.call('SET', KEYS[2], asof) else redis.call('DEL', KEYS[2]) end
if prev and prev ~= ARGV[3] then redis.call('ZREM', ARGV[7] .. prev, ARGV[5]) end
redis.call('ZADD', KEYS[4], ARGV[4], ARGV[5])
redis.call('ZADD', KEYS[5], ARGV[4], ARGV[5])
return 1
`;

const PUR_TX_PREFIX = 'onesub:purchase:tx:';
const PUR_USER_PREFIX = 'onesub:purchase:user:';
const PUR_USER_PRODUCT_PREFIX = 'onesub:purchase:user_product:';
const PUR_NON_CONSUMABLE_PREFIX = 'onesub:purchase:nc:';
/** SET KEYS[1] to ARGV[2] only if it still holds ARGV[1]. Returns 1 when set. */
const COMPARE_AND_SET_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  redis.call('SET', KEYS[1], ARGV[2])
  return 1
end
return 0
`;
const PUR_ALL = 'onesub:purchase:all';

export class RedisSubscriptionStore implements SubscriptionStore {
  constructor(private readonly redis: IORedis) {}

  async save(sub: SubscriptionInfo): Promise<void> {
    const score = Date.now();
    const txKey = SUB_TX_PREFIX + sub.originalTransactionId;
    const ownerKey = SUB_OWNER_PREFIX + sub.originalTransactionId;

    // Records written before the owner side-key existed have none; read the
    // previous owner from the record once, and the script backfills the key.
    let legacyPrevUserId = '';
    if ((await this.redis.exists(ownerKey)) === 0) {
      const prevRaw = await this.redis.get(txKey);
      legacyPrevUserId = prevRaw ? (JSON.parse(prevRaw) as SubscriptionInfo).userId : '';
    }

    // One script, so the ordering check and every write are atomic: WATCH would
    // not do, because it is per connection and this client is shared by
    // concurrent requests and queue workers.
    await this.redis.eval(
      SAVE_SUBSCRIPTION_SCRIPT,
      5,
      txKey,
      SUB_AS_OF_PREFIX + sub.originalTransactionId,
      ownerKey,
      SUB_USER_PREFIX + sub.userId,
      SUB_ALL_SORTED,
      JSON.stringify(sub),
      sub.stateAsOf ?? '',
      sub.userId,
      String(score),
      sub.originalTransactionId,
      legacyPrevUserId,
      SUB_USER_PREFIX,
    );
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
    // ZREVRANGE on the sorted set gives newest-first order (vs random SMEMBERS).
    const ids = await this.redis.zrevrange(SUB_ALL_SORTED, 0, -1);
    if (ids.length === 0) return [];
    const raws = await this.redis.mget(...ids.map((id) => SUB_TX_PREFIX + id));
    return raws.filter((r): r is string => r != null).map((r) => JSON.parse(r) as SubscriptionInfo);
  }

  async listFiltered(opts: ListFilteredOptions): Promise<ListFilteredResult> {
    const limit = opts.limit ?? 50;
    const offset = opts.offset ?? 0;
    const hasSecondaryFilters = !!(opts.status || opts.productId || opts.platform);

    if (opts.userId) {
      // Per-user path — already O(log n) via per-user sorted set.
      const candidates = await this.getAllByUserId(opts.userId);
      const filtered = candidates.filter((s) => {
        if (opts.status && s.status !== opts.status) return false;
        if (opts.productId && s.productId !== opts.productId) return false;
        if (opts.platform && s.platform !== opts.platform) return false;
        return true;
      });
      return { items: filtered.slice(offset, offset + limit), total: filtered.length, limit, offset };
    }

    if (!hasSecondaryFilters) {
      // Fast path: pure pagination with no filter — O(log n + limit) via sorted set.
      const [ids, total] = await Promise.all([
        this.redis.zrevrange(SUB_ALL_SORTED, offset, offset + limit - 1),
        this.redis.zcard(SUB_ALL_SORTED),
      ]);
      if (ids.length === 0) return { items: [], total, limit, offset };
      const raws = await this.redis.mget(...ids.map((id) => SUB_TX_PREFIX + id));
      const items = raws.filter((r): r is string => r != null).map((r) => JSON.parse(r) as SubscriptionInfo);
      return { items, total, limit, offset };
    }

    // Slow path: secondary filters require full scan. Results come in
    // newest-first order. For >100k rows pair with Postgres or Redis Stack.
    const allIds = await this.redis.zrevrange(SUB_ALL_SORTED, 0, -1);
    if (allIds.length === 0) return { items: [], total: 0, limit, offset };
    const raws = await this.redis.mget(...allIds.map((id) => SUB_TX_PREFIX + id));
    const all = raws.filter((r): r is string => r != null).map((r) => JSON.parse(r) as SubscriptionInfo);
    const filtered = all.filter((s) => {
      if (opts.status && s.status !== opts.status) return false;
      if (opts.productId && s.productId !== opts.productId) return false;
      if (opts.platform && s.platform !== opts.platform) return false;
      return true;
    });
    return { items: filtered.slice(offset, offset + limit), total: filtered.length, limit, offset };
  }
}

export class RedisPurchaseStore implements PurchaseStore {
  constructor(private readonly redis: IORedis) {}

  /**
   * Claim "this user's copy of this non-consumable" for `transactionId` — the
   * rule Postgres enforces with a partial unique index. SET NX makes the claim
   * atomic between concurrent saves. Returns true when this call took a fresh
   * claim (the caller releases it if its own write then fails); throws
   * NON_CONSUMABLE_ALREADY_OWNED when another live transaction holds it.
   */
  private async claimNonConsumable(userId: string, productId: string, transactionId: string): Promise<boolean> {
    const ncKey = PUR_NON_CONSUMABLE_PREFIX + userId + ':' + productId;
    if ((await this.redis.set(ncKey, transactionId, 'NX')) === 'OK') {
      // Rows written before this key existed have no claim. Look for one so a
      // legacy owner is still honoured, and backfill the claim to it.
      const legacy = await this.otherNonConsumable(userId, productId, transactionId);
      if (legacy) {
        await this.redis.set(ncKey, legacy);
        throw purchaseConflict('NON_CONSUMABLE_ALREADY_OWNED');
      }
      return true;
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      const holder = await this.redis.get(ncKey);
      if (holder === transactionId) return false;
      if (holder === null) {
        if ((await this.redis.set(ncKey, transactionId, 'NX')) === 'OK') return true;
        continue;
      }
      // Rows are written before their claim, so a claim whose row is gone — a
      // crash after the claim, or a moved/deleted row — is not ownership.
      const raw = await this.redis.get(PUR_TX_PREFIX + holder);
      const held = raw ? (JSON.parse(raw) as PurchaseInfo) : null;
      if (held && held.userId === userId && held.productId === productId) {
        throw purchaseConflict('NON_CONSUMABLE_ALREADY_OWNED');
      }
      // Take it over only if nobody else did meanwhile.
      if ((await this.redis.eval(COMPARE_AND_SET_SCRIPT, 1, ncKey, holder, transactionId)) === 1) return false;
    }
    throw new Error('[onesub/redis] non-consumable claim is contended; retry');
  }

  private async otherNonConsumable(userId: string, productId: string, transactionId: string): Promise<string | null> {
    const ids = (await this.redis.smembers(PUR_USER_PRODUCT_PREFIX + userId + ':' + productId)).filter(
      (id) => id !== transactionId,
    );
    if (ids.length === 0) return null;
    const raws = await this.redis.mget(...ids.map((id) => PUR_TX_PREFIX + id));
    for (const raw of raws) {
      const p = raw ? (JSON.parse(raw) as PurchaseInfo) : null;
      if (p?.type === 'non_consumable') return p.transactionId;
    }
    return null;
  }

  /** Release a non-consumable claim, only if `transactionId` is the one holding it. */
  private async releaseNonConsumable(userId: string, productId: string, transactionId: string): Promise<void> {
    const ncKey = PUR_NON_CONSUMABLE_PREFIX + userId + ':' + productId;
    if ((await this.redis.get(ncKey)) === transactionId) await this.redis.del(ncKey);
  }

  async savePurchase(purchase: PurchaseInfo): Promise<void> {
    const txKey = PUR_TX_PREFIX + purchase.transactionId;

    // Atomically claim the transaction key with SET NX — only the first
    // writer wins, which closes the GET-then-write race where two concurrent
    // saves with different userIds could both pass a read-side owner check
    // and both index the transaction (account-binding bypass).
    const claimed = await this.redis.set(txKey, JSON.stringify(purchase), 'NX');

    if (claimed !== 'OK') {
      // Key already exists — same TRANSACTION_BELONGS_TO_OTHER_USER semantics
      // as Postgres / InMemory implementations. Without this guard a stolen
      // receipt could be re-bound to a different account.
      const existing = await this.redis.get(txKey);
      const owner = existing ? (JSON.parse(existing) as PurchaseInfo).userId : null;
      if (owner !== null && owner !== purchase.userId) throw purchaseConflict('TRANSACTION_BELONGS_TO_OTHER_USER');
      // Same user: fall through to the index writes below instead of returning.
      // They are idempotent (zadd/sadd), and skipping them would make a crash
      // between the SET NX and the pipeline permanent — the tx key would exist
      // with no indexes and no retry could ever backfill them.
    }

    // The non-consumable claim is taken AFTER the row exists. A claim whose row
    // is missing is therefore abandoned (a crash), never still in flight — the
    // distinction claimNonConsumable relies on to take one over safely.
    if (purchase.type === 'non_consumable') {
      try {
        await this.claimNonConsumable(purchase.userId, purchase.productId, purchase.transactionId);
      } catch (err) {
        if (claimed === 'OK') await this.redis.del(txKey);
        throw err;
      }
    }

    const score = Date.parse(purchase.purchasedAt) || Date.now();
    const pipeline = this.redis.multi();
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

  /**
   * Purchases for one user + product, most-recent-first.
   *
   * Served from the `user_product` set that `savePurchase` already maintains for
   * `hasPurchased`, so this reads only the rows for this product rather than the
   * user's whole purchase history.
   *
   * That set is unordered — unlike the per-user sorted set — so the
   * most-recent-first contract is restored by an explicit sort here. The row
   * count is per-product, so this is small.
   */
  async getPurchasesForProduct(userId: string, productId: string): Promise<PurchaseInfo[]> {
    const ids = await this.redis.smembers(PUR_USER_PRODUCT_PREFIX + userId + ':' + productId);
    if (ids.length === 0) return [];
    const raws = await this.redis.mget(...ids.map((id) => PUR_TX_PREFIX + id));
    return raws
      .filter((r): r is string => r != null)
      .map((r) => JSON.parse(r) as PurchaseInfo)
      .sort((a, b) => Date.parse(b.purchasedAt) - Date.parse(a.purchasedAt));
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
    if (existing.type === 'non_consumable') {
      await this.claimNonConsumable(newUserId, existing.productId, transactionId);
      await this.releaseNonConsumable(existing.userId, existing.productId, transactionId);
    }

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
    // Every row for this user + product is going, so its claim goes too.
    pipeline.del(PUR_NON_CONSUMABLE_PREFIX + userId + ':' + productId);
    await pipeline.exec();
    return ids.length;
  }

  async deletePurchaseByTransactionId(transactionId: string): Promise<boolean> {
    const txKey = PUR_TX_PREFIX + transactionId;
    const raw = await this.redis.get(txKey);
    if (!raw) return false;
    const existing = JSON.parse(raw) as PurchaseInfo;
    if (existing.type === 'non_consumable') {
      await this.releaseNonConsumable(existing.userId, existing.productId, transactionId);
    }

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
 * Redis-backed cache adapter — share Apple API JWT / Google OAuth tokens across cluster nodes.
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

const WEBHOOK_EVENT_PREFIX = 'onesub:webhook:event:';
const DEFAULT_WEBHOOK_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days — covers Apple's 3-day retry window

/**
 * Redis-backed webhook idempotency store.
 *
 * Uses `SET key '1' EX ttl NX` — a single atomic command that sets the key
 * only if it does not already exist. Returns 'OK' (new event) or null
 * (already seen), with no race between a GET and a subsequent SET.
 *
 * Prefer this over `CacheWebhookEventStore(new RedisCacheAdapter(...))` for
 * production deployments; the cache-based variant is non-atomic under
 * concurrent retries.
 */
export class RedisWebhookEventStore implements WebhookEventStore {
  constructor(
    private readonly redis: IORedis,
    private readonly ttlSeconds = DEFAULT_WEBHOOK_TTL_SECONDS,
  ) {}

  async markIfNew(provider: 'apple' | 'google', eventId: string): Promise<boolean> {
    const key = WEBHOOK_EVENT_PREFIX + provider + ':' + eventId;
    const result = await this.redis.set(key, '1', 'EX', this.ttlSeconds, 'NX');
    return result === 'OK';
  }

  async unmark(provider: 'apple' | 'google', eventId: string): Promise<void> {
    await this.redis.del(WEBHOOK_EVENT_PREFIX + provider + ':' + eventId);
  }
}
