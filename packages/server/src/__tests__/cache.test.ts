import { describe, expect, it } from 'vitest';
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
});
