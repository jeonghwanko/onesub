import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemoryCacheAdapter } from '../cache.js';

describe('InMemoryCacheAdapter', () => {
  it('returns null for missing keys', async () => {
    const cache = new InMemoryCacheAdapter();
    expect(await cache.get('absent')).toBeNull();
  });

  it('round-trips a value', async () => {
    const cache = new InMemoryCacheAdapter();
    await cache.set('k', { token: 'abc', n: 1 });
    expect(await cache.get('k')).toEqual({ token: 'abc', n: 1 });
  });

  it('expires entries after the TTL elapses', async () => {
    const cache = new InMemoryCacheAdapter();
    await cache.set('k', 'v', 1);
    expect(await cache.get('k')).toBe('v');
    // Force expiry by moving the clock forward via a sleep substitute.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(await cache.get('k')).toBeNull();
  });

  it('treats ttl=0 / undefined as no-expiry', async () => {
    const cache = new InMemoryCacheAdapter();
    await cache.set('forever', 'v');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await cache.get('forever')).toBe('v');
  });

  it('del removes a key', async () => {
    const cache = new InMemoryCacheAdapter();
    await cache.set('k', 'v');
    await cache.del('k');
    expect(await cache.get('k')).toBeNull();
  });

  describe('lazy sweep of expired entries', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('evicts expired write-once keys after enough sets, without a get()', async () => {
      vi.useFakeTimers();
      const cache = new InMemoryCacheAdapter();

      // Write-once-never-read keys (like webhook dedup markers) with 1s TTL.
      await cache.set('dedup:1', '1', 1);
      await cache.set('dedup:2', '1', 1);
      expect(cache.size).toBe(2);

      // Let them expire — but never get() them, so per-key eviction can't fire.
      vi.advanceTimersByTime(2000);
      expect(cache.size).toBe(2);

      // Enough subsequent sets trigger the periodic sweep.
      for (let i = 0; i < 256; i++) {
        await cache.set(`live:${i}`, i, 3600);
      }

      // The expired dedup keys are gone; only the live keys remain.
      expect(cache.size).toBe(256);
      expect(await cache.get('live:0')).toBe(0);
      expect(await cache.get('live:255')).toBe(255);
    });

    it('sweep never evicts unexpired or no-expiry entries', async () => {
      vi.useFakeTimers();
      const cache = new InMemoryCacheAdapter();

      await cache.set('forever', 'v'); // no TTL
      await cache.set('long', 'v', 3600); // unexpired TTL
      for (let i = 0; i < 300; i++) {
        await cache.set(`filler:${i}`, i, 3600); // crosses the sweep threshold
      }

      expect(await cache.get('forever')).toBe('v');
      expect(await cache.get('long')).toBe('v');
      expect(cache.size).toBe(302);
    });
  });
});
