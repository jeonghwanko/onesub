import type { CacheAdapter } from './cache.js';
import { InMemoryCacheAdapter } from './cache.js';

/**
 * Short-lived cache for aggregate metrics responses.
 *
 * The metrics endpoints each reduce every record in the store. The dashboard
 * overview calls four of them per render and opts out of Next.js fetch caching,
 * so before this every browser refresh — by every operator — re-scanned the
 * whole subscription and purchase tables four times. Aggregate counts are the
 * one part of this server where a few seconds of staleness costs nothing, so
 * bounding the scan rate is the cheapest protection available and it works for
 * every store implementation rather than just Postgres.
 *
 * Only the admin-gated `/onesub/metrics/*` responses go through here. Nothing
 * that decides entitlement (`/onesub/status`, `/onesub/entitlement(s)`,
 * validation) is ever cached — those must reflect the store as of the request.
 *
 * Storage is private to the cache instance, NOT the shared `getDefaultCache()`
 * adapter, and that is deliberate. Metrics keys describe "every record in this
 * store", which the key itself cannot discriminate: two middlewares in one
 * process, or two deployments pointed at one Redis database, would read each
 * other's totals for any query whose window happened to match. Sharing would
 * also make correctness depend on a globally mutable default that a host can
 * swap at any time. The cost of keeping it private is that a K-process
 * deployment recomputes up to K times per TTL window instead of once — still a
 * fixed bound, where the uncached behaviour had none.
 */

/** Bypass marker: a TTL of zero or less disables caching entirely. */
function isDisabled(ttlSeconds: number): boolean {
  return !Number.isFinite(ttlSeconds) || ttlSeconds <= 0;
}

export interface MetricsCache {
  /**
   * Return the value for `keyParts`, computing it via `produce` on a miss.
   *
   * `keyParts` must not contain a raw request timestamp — see
   * `quantizeToWindow`.
   */
  resolve<T>(keyParts: readonly (string | number)[], produce: () => Promise<T>): Promise<T>;
  /** Snap a millisecond timestamp onto the TTL grid, for use in a cache key. */
  quantizeToWindow(ms: number): number;
}

/**
 * @param ttlSeconds Freshness bound. `0` (or less) disables the cache.
 * @param storage    Backing store. Defaults to storage private to this
 *                   instance — see the note above on why this is not the shared
 *                   adapter. Injectable for tests.
 */
export function createMetricsCache(
  ttlSeconds: number,
  storage: CacheAdapter = new InMemoryCacheAdapter(),
): MetricsCache {
  // Thundering-herd guard, mirroring the Google OAuth token minter: without it,
  // the four dashboard requests that arrive together on a cold cache each start
  // their own full scan. Keyed the same as the cache entry.
  const inflight = new Map<string, Promise<unknown>>();

  const gridMs = Math.max(1, Math.floor(ttlSeconds * 1000));

  return {
    quantizeToWindow(ms: number): number {
      if (isDisabled(ttlSeconds)) return ms;
      // Floor onto the TTL grid. Callers pass request-supplied `from`/`to`,
      // which carry millisecond precision — the dashboard sends `new Date()` as
      // `to`, so an unquantized key would be unique per request and never hit.
      // Note this only groups requests into a shared key: the value stored is
      // the one computed for whichever request missed first, using ITS exact
      // window. So the counts always describe a real window, at most one TTL
      // stale — the response's own `from`/`to` echo stays the caller's values.
      return Math.floor(ms / gridMs) * gridMs;
    },

    async resolve<T>(keyParts: readonly (string | number)[], produce: () => Promise<T>): Promise<T> {
      if (isDisabled(ttlSeconds)) return produce();

      const key = `metrics:${keyParts.join(':')}`;
      const cache = storage;

      const hit = await cache.get<T>(key);
      if (hit !== null && hit !== undefined) return hit;

      const pending = inflight.get(key) as Promise<T> | undefined;
      if (pending) return pending;

      const promise = (async () => {
        const value = await produce();
        await cache.set(key, value, ttlSeconds);
        return value;
      })();
      inflight.set(key, promise);
      try {
        return await promise;
      } finally {
        // Always cleared, including on failure — a rejected computation must not
        // be handed to later callers, and nothing was written to the cache.
        inflight.delete(key);
      }
    },
  };
}
