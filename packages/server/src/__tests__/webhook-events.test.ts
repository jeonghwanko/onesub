import { describe, expect, it } from 'vitest';
import { CacheWebhookEventStore, InMemoryWebhookEventStore } from '../webhook-events.js';
import { InMemoryCacheAdapter } from '../cache.js';

describe('InMemoryWebhookEventStore', () => {
  it('returns true the first time, false on retry', async () => {
    const store = new InMemoryWebhookEventStore();
    expect(await store.markIfNew('apple', 'uuid-1')).toBe(true);
    expect(await store.markIfNew('apple', 'uuid-1')).toBe(false);
  });

  it('keys by provider so apple/google ids never collide', async () => {
    const store = new InMemoryWebhookEventStore();
    expect(await store.markIfNew('apple', 'shared')).toBe(true);
    expect(await store.markIfNew('google', 'shared')).toBe(true);
  });

  it('expires entries after the TTL', async () => {
    const store = new InMemoryWebhookEventStore(1); // 1-second TTL
    expect(await store.markIfNew('apple', 'uuid-1')).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    // Re-eligible after expiry — Apple/Google retries beyond the window are
    // effectively new events, which is the intended behavior.
    expect(await store.markIfNew('apple', 'uuid-1')).toBe(true);
  });
});

describe('CacheWebhookEventStore', () => {
  it('uses any CacheAdapter for cluster-shared dedupe', async () => {
    const cache = new InMemoryCacheAdapter();
    const store = new CacheWebhookEventStore(cache);
    expect(await store.markIfNew('google', 'msg-1')).toBe(true);
    expect(await store.markIfNew('google', 'msg-1')).toBe(false);

    // A second store backed by the same cache sees the prior write — this is
    // the multi-instance idempotency guarantee we ship.
    const store2 = new CacheWebhookEventStore(cache);
    expect(await store2.markIfNew('google', 'msg-1')).toBe(false);
  });
});
