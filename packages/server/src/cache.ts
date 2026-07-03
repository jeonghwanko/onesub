/**
 * Pluggable cache adapter.
 *
 * Used internally by the Apple JWT minter, Google OAuth token minter, and any
 * future per-process cache. The default `InMemoryCacheAdapter` matches the
 * pre-adapter behavior — module-level state, lost on restart, not shared
 * between cluster nodes.
 *
 * For multi-instance deployments, pass a `RedisCacheAdapter` in
 * `OneSubMiddlewareConfig.cache` so all nodes share the same JWKS / token
 * cache and avoid every node re-minting on its own schedule.
 */
export interface CacheAdapter {
  get<T = unknown>(key: string): Promise<T | null>;
  /** TTL in seconds. Pass 0 / undefined for no expiry. */
  set<T = unknown>(key: string, value: T, ttlSeconds?: number): Promise<void>;
  del(key: string): Promise<void>;
}

interface Entry {
  value: unknown;
  /** ms-since-epoch expiry; 0 = never expires */
  expiresAt: number;
}

/** Sweep expired entries once every this many set() calls. */
const SWEEP_EVERY_N_SETS = 256;

/**
 * Process-local in-memory cache. Default for single-instance deployments.
 */
export class InMemoryCacheAdapter implements CacheAdapter {
  private readonly entries = new Map<string, Entry>();
  private setsSinceSweep = 0;

  async get<T>(key: string): Promise<T | null> {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== 0 && entry.expiresAt < Date.now()) {
      this.entries.delete(key);
      return null;
    }
    return entry.value as T;
  }

  async set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    const expiresAt = ttlSeconds && ttlSeconds > 0 ? Date.now() + ttlSeconds * 1000 : 0;
    this.entries.set(key, { value, expiresAt });
    // Lazy sweep: get() only evicts the key it touches, so write-once-never-
    // read keys (e.g. webhook event dedup markers) would otherwise accumulate
    // forever. Amortized O(1) per set — the O(n) scan runs once per
    // SWEEP_EVERY_N_SETS writes.
    if (++this.setsSinceSweep >= SWEEP_EVERY_N_SETS) {
      this.sweepExpired();
    }
  }

  async del(key: string): Promise<void> {
    this.entries.delete(key);
  }

  /** Evict every entry whose TTL has elapsed. */
  private sweepExpired(): void {
    this.setsSinceSweep = 0;
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt !== 0 && entry.expiresAt < now) this.entries.delete(key);
    }
  }

  /** Test helper — clear everything. Not part of the public CacheAdapter contract. */
  clear(): void {
    this.entries.clear();
    this.setsSinceSweep = 0;
  }

  /** Test helper — number of entries currently held (including not-yet-swept expired ones). */
  get size(): number {
    return this.entries.size;
  }
}

/**
 * Module-level singleton used by providers when no per-call adapter is
 * supplied. Keeps the existing single-instance behavior with zero config.
 */
let defaultAdapter: CacheAdapter = new InMemoryCacheAdapter();

export function getDefaultCache(): CacheAdapter {
  return defaultAdapter;
}

export function setDefaultCache(adapter: CacheAdapter): void {
  defaultAdapter = adapter;
}

