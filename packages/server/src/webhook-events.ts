import type { CacheAdapter } from './cache.js';

/**
 * Pluggable webhook-event idempotency store.
 *
 * Apple sends `notificationUUID` and Google Pub/Sub sends `messageId` — both
 * are guaranteed unique per notification. Apple/Google will retry on any
 * non-2xx response (Apple: ~3 days, Google: configurable Pub/Sub policy), so
 * the same notification can hit our handler multiple times if the previous
 * response timed out, the DB was briefly down, etc. We must not double-apply
 * state changes (extra subscription days, refunded purchase being deleted
 * twice, consumption response being PUT twice).
 *
 * `markIfNew` returns `true` when the caller should process the event,
 * `false` when it has been seen before. Implementations decide retention —
 * once-seen IDs are kept long enough that retries from the source can't beat
 * the TTL (we recommend ≥ 7 days).
 */
export interface WebhookEventStore {
  /**
   * Atomically register the given event id. Returns `true` if it's new (first
   * time we've seen it), `false` if it was already seen.
   *
   * `provider` lets us key by source so Apple's notificationUUID and Google's
   * messageId never collide.
   */
  markIfNew(provider: 'apple' | 'google', eventId: string): Promise<boolean>;
}

/** Default 7-day retention — covers Apple's 3-day retry window plus headroom. */
const DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * In-memory implementation. Suitable for single-instance dev/test; for
 * production multi-instance use the Redis or Postgres variants so retries to
 * other nodes are still deduped.
 */
export class InMemoryWebhookEventStore implements WebhookEventStore {
  private readonly seen = new Map<string, number>();

  constructor(private readonly ttlSeconds = DEFAULT_TTL_SECONDS) {}

  async markIfNew(provider: 'apple' | 'google', eventId: string): Promise<boolean> {
    this.evictExpired();
    const key = `${provider}:${eventId}`;
    if (this.seen.has(key)) return false;
    this.seen.set(key, Date.now() + this.ttlSeconds * 1000);
    return true;
  }

  private evictExpired(): void {
    const now = Date.now();
    for (const [key, expiresAt] of this.seen) {
      if (expiresAt < now) this.seen.delete(key);
    }
  }
}

/**
 * Cache-backed implementation — works with any `CacheAdapter`.
 *
 * Uses a `get` → `set` sequence, which is **not** atomic under concurrent
 * retries: two simultaneous calls for the same id can both read null and
 * both return `true`. The downstream store PKs / BullMQ jobId dedup catch
 * this worst case.
 *
 * For Redis deployments prefer `RedisWebhookEventStore` (from
 * `@onesub/server`) which uses a single `SET NX` command and is fully
 * atomic.
 */
export class CacheWebhookEventStore implements WebhookEventStore {
  constructor(
    private readonly cache: CacheAdapter,
    private readonly ttlSeconds = DEFAULT_TTL_SECONDS,
  ) {}

  async markIfNew(provider: 'apple' | 'google', eventId: string): Promise<boolean> {
    const key = `webhook:event:${provider}:${eventId}`;
    const existing = await this.cache.get<string>(key);
    if (existing) return false;
    await this.cache.set(key, '1', this.ttlSeconds);
    return true;
  }
}
