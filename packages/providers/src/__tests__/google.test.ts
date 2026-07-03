/**
 * Tests for the Google Play Developer provider — fetch is mocked, pinning
 * request shapes (query params, pagination) and price/unit conversions.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { generateKeyPairSync } from 'crypto';
import {
  createSubscription,
  createOneTimePurchase,
  deleteProduct,
  listProducts,
} from '../google.js';

let serviceAccountKey: string;

function makeKey(email: string): string {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return JSON.stringify({
    type: 'service_account',
    project_id: 'proj-x',
    client_email: email,
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
    token_uri: 'https://oauth2.googleapis.com/token',
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
  // Unique per test — the module-level token cache is keyed by key hash, so a
  // fresh key guarantees a fresh token fetch.
  serviceAccountKey = makeKey(`sa-${Math.random()}@x.iam.gserviceaccount.com`);
});

interface MockCall {
  url: string;
  method: string;
  body?: unknown;
}

function mockFetch(
  routes: Array<{ match: (url: string, method: string) => boolean; status?: number; body?: unknown }>,
  opts?: { tokens?: string[] },
): MockCall[] {
  const calls: MockCall[] = [];
  let tokenCount = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? 'GET';
    if (u.includes('oauth2.googleapis.com')) {
      const token = opts?.tokens?.[tokenCount] ?? `tok_${tokenCount}`;
      tokenCount += 1;
      calls.push({ url: u, method });
      return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: token, expires_in: 3600 }), json: async () => ({ access_token: token, expires_in: 3600 }) } as Response;
    }
    calls.push({ url: u, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const route = routes.find((r) => r.match(u, method));
    if (!route) throw new Error(`[test] unmatched URL: ${method} ${u}`);
    const status = route.status ?? 200;
    const text = route.body === undefined ? '' : JSON.stringify(route.body);
    return { ok: status >= 200 && status < 300, status, text: async () => text } as Response;
  }));
  return calls;
}

describe('token cache isolation', () => {
  it('does not reuse another service account\'s token (distinct keys → distinct token fetches)', async () => {
    const keyA = makeKey('a@x.iam.gserviceaccount.com');
    const keyB = makeKey('b@x.iam.gserviceaccount.com');
    const calls = mockFetch([
      { match: (u) => u.includes('/subscriptions'), body: { subscriptions: [] } },
      { match: (u) => u.includes('/inappproducts'), body: { inappproduct: [] } },
    ]);

    await listProducts({ packageName: 'com.a', serviceAccountKey: keyA });
    await listProducts({ packageName: 'com.b', serviceAccountKey: keyB });

    const tokenFetches = calls.filter((c) => c.url.includes('oauth2.googleapis.com'));
    expect(tokenFetches).toHaveLength(2);
  });
});

describe('createSubscription', () => {
  it('sends productId and regionsVersion.version as query params', async () => {
    const calls = mockFetch([
      { match: (u, m) => u.includes('/subscriptions') && m === 'POST' && !u.includes(':activate'), body: {} },
      { match: (u) => u.includes(':activate'), body: {} },
    ]);

    const result = await createSubscription({
      productId: 'premium', name: 'Premium', price: 499, currency: 'USD', period: 'monthly',
      packageName: 'com.example', serviceAccountKey,
    });

    expect(result.success).toBe(true);
    const create = calls.find((c) => c.method === 'POST' && c.url.includes('/subscriptions?'));
    expect(create).toBeDefined();
    expect(create!.url).toContain('productId=premium');
    expect(create!.url).toContain(`regionsVersion.version=${encodeURIComponent('2022/02')}`);
  });

  it('rejects an unsupported primary currency with a clear error', async () => {
    mockFetch([]);
    const result = await createSubscription({
      productId: 'p', name: 'P', price: 1000, currency: 'BRL', period: 'monthly',
      packageName: 'com.example', serviceAccountKey,
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Unsupported currency 'BRL'/);
  });

  it('skips duplicate extraRegions currencies instead of failing the whole create', async () => {
    const calls = mockFetch([
      { match: (u, m) => u.includes('/subscriptions') && m === 'POST' && !u.includes(':activate'), body: {} },
      { match: (u) => u.includes(':activate'), body: {} },
    ]);

    const result = await createSubscription({
      productId: 'premium', name: 'Premium', price: 499, currency: 'USD', period: 'monthly',
      extraRegions: [{ currency: 'KRW', price: 5900 }, { currency: 'KRW', price: 6900 }],
      packageName: 'com.example', serviceAccountKey,
    });

    expect(result.success).toBe(true);
    expect(result.skippedRegions).toEqual(['KRW']);
    const create = calls.find((c) => c.method === 'POST' && c.url.includes('/subscriptions?'));
    const regionCodes = (create!.body as { basePlans: Array<{ regionalConfigs: Array<{ regionCode: string }> }> })
      .basePlans[0].regionalConfigs.map((r) => r.regionCode);
    expect(regionCodes).toEqual(['US', 'KR']);  // no duplicate KR
  });

  it('skips unmapped extraRegions and reports them instead of colliding onto US', async () => {
    const calls = mockFetch([
      { match: (u, m) => u.includes('/subscriptions') && m === 'POST' && !u.includes(':activate'), body: {} },
      { match: (u) => u.includes(':activate'), body: {} },
    ]);

    const result = await createSubscription({
      productId: 'premium', name: 'Premium', price: 499, currency: 'USD', period: 'monthly',
      extraRegions: [{ currency: 'BRL', price: 1990 }, { currency: 'KRW', price: 6900 }],
      packageName: 'com.example', serviceAccountKey,
    });

    expect(result.success).toBe(true);
    expect(result.skippedRegions).toEqual(['BRL']);
    const create = calls.find((c) => c.method === 'POST' && c.url.includes('/subscriptions?'));
    const regionCodes = (create!.body as { basePlans: Array<{ regionalConfigs: Array<{ regionCode: string }> }> })
      .basePlans[0].regionalConfigs.map((r) => r.regionCode);
    expect(regionCodes).toEqual(['US', 'KR']);
  });
});

describe('createOneTimePurchase', () => {
  it('does not let an unmapped extra region overwrite the primary price', async () => {
    const calls = mockFetch([
      { match: (u, m) => u.includes('/inappproducts') && m === 'POST', body: {} },
    ]);

    const result = await createOneTimePurchase({
      productId: 'coins', name: 'Coins', price: 499, currency: 'USD', type: 'consumable',
      extraRegions: [{ currency: 'BRL', price: 1990 }],
      packageName: 'com.example', serviceAccountKey,
    });

    expect(result.success).toBe(true);
    expect(result.skippedRegions).toEqual(['BRL']);
    const create = calls.find((c) => c.method === 'POST' && c.url.includes('/inappproducts'));
    const prices = (create!.body as { prices: Record<string, { currency: string; priceMicros: string }> }).prices;
    expect(prices['US']).toEqual({ currency: 'USD', priceMicros: '4990000' });
  });
});

describe('deleteProduct — empty-body success', () => {
  it('treats an empty 204 DELETE response as success', async () => {
    mockFetch([
      { match: (u, m) => u.includes('/inappproducts/') && m === 'DELETE', status: 204 },
    ]);

    const result = await deleteProduct({
      productId: 'coins', productType: 'consumable',
      packageName: 'com.example', serviceAccountKey,
    });

    expect(result).toEqual({ success: true });
  });
});

describe('listProducts', () => {
  it('converts zero-decimal subscription prices without the cents scaling', async () => {
    mockFetch([
      {
        match: (u) => u.includes('/subscriptions'),
        body: {
          subscriptions: [{
            productId: 'premium_krw',
            listings: [{ languageCode: 'en-US', title: 'Premium' }],
            basePlans: [{
              basePlanId: 'monthly', state: 'ACTIVE',
              regionalConfigs: [{ regionCode: 'KR', price: { currencyCode: 'KRW', units: '4900', nanos: 0 } }],
            }],
          }],
        },
      },
      { match: (u) => u.includes('/inappproducts'), body: { inappproduct: [] } },
    ]);

    const products = await listProducts({ packageName: 'com.example', serviceAccountKey });
    expect(products).toHaveLength(1);
    expect(products[0].price).toBe(4900);
    expect(products[0].currency).toBe('KRW');
  });

  it('paginates subscriptions via nextPageToken and inappproducts via tokenPagination', async () => {
    mockFetch([
      { match: (u) => u.includes('/subscriptions') && u.includes('pageToken=s2'), body: { subscriptions: [{ productId: 'sub2', basePlans: [] }] } },
      { match: (u) => u.includes('/subscriptions'), body: { subscriptions: [{ productId: 'sub1', basePlans: [] }], nextPageToken: 's2' } },
      { match: (u) => u.includes('/inappproducts') && u.includes('token=i2'), body: { inappproduct: [{ sku: 'iap2' }] } },
      { match: (u) => u.includes('/inappproducts'), body: { inappproduct: [{ sku: 'iap1' }], tokenPagination: { nextPageToken: 'i2' } } },
    ]);

    const products = await listProducts({ packageName: 'com.example', serviceAccountKey });
    expect(products.map((p) => p.productId).sort()).toEqual(['iap1', 'iap2', 'sub1', 'sub2']);
  });

  it('throws when both halves fail instead of returning an empty catalog', async () => {
    mockFetch([
      { match: () => true, status: 401, body: { error: { message: 'unauthorized' } } },
    ]);

    await expect(listProducts({ packageName: 'com.example', serviceAccountKey }))
      .rejects.toThrow(/Google Play API error/);
  });
});
