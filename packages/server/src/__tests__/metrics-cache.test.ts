/**
 * createMetricsCache — the freshness bound on aggregate metrics responses.
 *
 * Every metrics endpoint reduces the whole store, so this cache is what stops a
 * dashboard refresh loop from re-scanning it. The behaviours worth pinning down
 * are the ones that would either defeat the purpose (a key that never repeats)
 * or serve something wrong (a stale hit past its TTL, a shared entry between
 * unrelated stores, a remembered failure).
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { createMetricsCache } from '../metrics-cache.js';
import { InMemoryCacheAdapter } from '../cache.js';

/** A producer that counts invocations. */
function counted<T>(value: T) {
  let calls = 0;
  return { calls: () => calls, produce: async () => { calls++; return value; } };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('quantizeToWindow', () => {
  it('snaps timestamps onto the TTL grid so repeat requests share a key', () => {
    // The dashboard sends `to = new Date()` at millisecond precision. Without
    // this, every request would be a unique key and the cache would never hit.
    const cache = createMetricsCache(30);
    expect(cache.quantizeToWindow(0)).toBe(0);
    expect(cache.quantizeToWindow(29_999)).toBe(0);
    expect(cache.quantizeToWindow(30_000)).toBe(30_000);
    expect(cache.quantizeToWindow(59_999)).toBe(30_000);
    expect(cache.quantizeToWindow(60_001)).toBe(60_000);
  });

  it('is the identity when caching is disabled', () => {
    const cache = createMetricsCache(0);
    expect(cache.quantizeToWindow(12_345)).toBe(12_345);
  });
});

describe('resolve — hit / miss', () => {
  it('computes once per key', async () => {
    const cache = createMetricsCache(30);
    const p = counted({ total: 7 });

    expect(await cache.resolve(['active', 0], p.produce)).toEqual({ total: 7 });
    expect(await cache.resolve(['active', 0], p.produce)).toEqual({ total: 7 });
    expect(p.calls()).toBe(1);
  });

  it('treats every key part as significant', async () => {
    const cache = createMetricsCache(30);
    const p = counted({ total: 1 });

    await cache.resolve(['started', 0, 30_000, 'none'], p.produce);
    await cache.resolve(['started', 0, 30_000, 'day'], p.produce);   // groupBy differs
    await cache.resolve(['started', 0, 60_000, 'none'], p.produce);  // window differs
    await cache.resolve(['expired', 0, 30_000, 'none'], p.produce);  // endpoint differs

    expect(p.calls()).toBe(4);
  });

  it('bypasses entirely when the TTL is zero', async () => {
    const cache = createMetricsCache(0);
    const p = counted({ total: 1 });

    await cache.resolve(['active', 0], p.produce);
    await cache.resolve(['active', 0], p.produce);
    await cache.resolve(['active', 0], p.produce);

    expect(p.calls()).toBe(3);
  });

  it('recomputes once the TTL has elapsed', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-26T00:00:00.000Z'));
    const cache = createMetricsCache(30);
    const p = counted({ total: 1 });

    await cache.resolve(['active', 0], p.produce);
    vi.setSystemTime(new Date('2026-07-26T00:00:29.000Z'));
    await cache.resolve(['active', 0], p.produce);
    expect(p.calls()).toBe(1);

    vi.setSystemTime(new Date('2026-07-26T00:00:31.000Z'));
    await cache.resolve(['active', 0], p.produce);
    expect(p.calls()).toBe(2);
  });
});

describe('resolve — concurrent callers', () => {
  it('collapses simultaneous misses into one computation', async () => {
    // The dashboard overview fires its requests together; on a cold cache each
    // one would otherwise start its own full scan.
    const cache = createMetricsCache(30);
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const produce = async () => { calls++; await gate; return { total: 3 }; };

    const all = Promise.all([
      cache.resolve(['active', 0], produce),
      cache.resolve(['active', 0], produce),
      cache.resolve(['active', 0], produce),
    ]);
    release();
    const results = await all;

    expect(results).toEqual([{ total: 3 }, { total: 3 }, { total: 3 }]);
    expect(calls).toBe(1);
  });

  it('does not collapse different keys', async () => {
    const cache = createMetricsCache(30);
    let calls = 0;
    const produce = async () => { calls++; return { total: calls }; };

    await Promise.all([
      cache.resolve(['active', 0], produce),
      cache.resolve(['started', 0, 1, 'none'], produce),
    ]);

    expect(calls).toBe(2);
  });
});

describe('resolve — failures', () => {
  it('propagates and remembers nothing', async () => {
    const cache = createMetricsCache(30);
    let calls = 0;
    const failing = async (): Promise<{ total: number }> => {
      calls++;
      throw new Error('store unavailable');
    };

    await expect(cache.resolve(['active', 0], failing)).rejects.toThrow(/store unavailable/);
    await expect(cache.resolve(['active', 0], failing)).rejects.toThrow(/store unavailable/);
    expect(calls).toBe(2);

    // A later success is cached normally — the failure left no poisoned entry.
    const p = counted({ total: 5 });
    expect(await cache.resolve(['active', 0], p.produce)).toEqual({ total: 5 });
    expect(await cache.resolve(['active', 0], p.produce)).toEqual({ total: 5 });
    expect(p.calls()).toBe(1);
  });

  it('does not strand concurrent callers when the computation fails', async () => {
    const cache = createMetricsCache(30);
    const failing = async (): Promise<{ total: number }> => {
      throw new Error('boom');
    };
    const results = await Promise.allSettled([
      cache.resolve(['active', 0], failing),
      cache.resolve(['active', 0], failing),
    ]);
    expect(results.every((r) => r.status === 'rejected')).toBe(true);
  });
});

describe('resolve — isolation', () => {
  it('two cache instances never see each other’s entries', async () => {
    // This is why the metrics cache does not use the shared default adapter: a
    // metrics key describes "every record in this store" and cannot tell one
    // store from another, so two middlewares in one process would otherwise
    // read each other's totals for any matching window.
    const a = createMetricsCache(30);
    const b = createMetricsCache(30);
    const pa = counted({ total: 1 });
    const pb = counted({ total: 999 });

    expect(await a.resolve(['active', 0], pa.produce)).toEqual({ total: 1 });
    expect(await b.resolve(['active', 0], pb.produce)).toEqual({ total: 999 });
    expect(pa.calls()).toBe(1);
    expect(pb.calls()).toBe(1);
  });

  it('honours injected storage', async () => {
    const storage = new InMemoryCacheAdapter();
    const cache = createMetricsCache(30, storage);
    const p = counted({ total: 2 });

    await cache.resolve(['active', 0], p.produce);
    expect(storage.size).toBe(1);

    storage.clear();
    await cache.resolve(['active', 0], p.produce);
    expect(p.calls()).toBe(2);
  });
});
