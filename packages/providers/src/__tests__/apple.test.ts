/**
 * Tests for the Apple App Store Connect provider — fetch is mocked, so these
 * pin the request shapes (URLs, payloads, pagination) and the price-point
 * unit conversion without touching the real API.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { generateKeyPairSync } from 'crypto';
import {
  findPricePoint,
  createSubscription,
  createOneTimePurchase,
  deleteProduct,
  listProducts,
  resolveAppId,
} from '../apple.js';
import type { AppleCredentials } from '../apple.js';
import { backoff } from '../retry.js';

let creds: AppleCredentials;

beforeEach(() => {
  vi.restoreAllMocks();
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  creds = {
    keyId: 'KEY1',
    issuerId: 'issuer-uuid',
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
  };
});

interface MockCall {
  url: string;
  method: string;
  body?: unknown;
}

/** Route fetch by URL substring → JSON body (string) or a raw Response-ish. */
function mockFetch(routes: Array<{ match: (url: string, method: string) => boolean; status?: number; body?: unknown }>): MockCall[] {
  const calls: MockCall[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? 'GET';
    calls.push({ url: u, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const route = routes.find((r) => r.match(u, method));
    if (!route) throw new Error(`[test] unmatched URL: ${method} ${u}`);
    const status = route.status ?? 200;
    const text = route.body === undefined ? '' : JSON.stringify(route.body);
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => text,
    } as Response;
  }));
  return calls;
}

/**
 * Queue-based fetch mock for retry tests: each call consumes the next entry
 * (the last one repeats). Records the Authorization header per call.
 */
function mockFetchSequence(
  responses: Array<{ status: number; body?: unknown; retryAfter?: string }>,
): Array<{ authorization?: string }> {
  const calls: Array<{ authorization?: string }> = [];
  let i = 0;
  vi.stubGlobal('fetch', vi.fn(async (_url: string | URL, init?: RequestInit) => {
    const r = responses[Math.min(i, responses.length - 1)];
    i += 1;
    calls.push({ authorization: (init?.headers as Record<string, string> | undefined)?.['Authorization'] });
    const text = r.body === undefined ? '' : JSON.stringify(r.body);
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      headers: new Headers(r.retryAfter !== undefined ? { 'Retry-After': r.retryAfter } : {}),
      text: async () => text,
    } as Response;
  }));
  return calls;
}

const pricePoint = (id: string, customerPrice: string) => ({ id, attributes: { customerPrice } });

describe('appleRequest — 429 retry', () => {
  const appsBody = { data: [{ id: 'app1', attributes: { bundleId: 'com.x' } }] };
  const rateLimitBody = { errors: [{ status: '429', code: 'RATE_LIMIT_EXCEEDED', title: 'Rate limit exceeded', detail: 'hourly limit' }] };

  it('retries once on 429 then succeeds, with a fresh JWT per attempt', async () => {
    const sleep = vi.spyOn(backoff, 'sleep').mockResolvedValue(undefined);
    const calls = mockFetchSequence([
      { status: 429, body: rateLimitBody },
      { status: 200, body: appsBody },
    ]);

    const appId = await resolveAppId(creds, 'com.x');

    expect(appId).toBe('app1');
    expect(calls).toHaveLength(2);
    // No Retry-After header → first exponential backoff step
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([1000]);
    // ES256 signatures are nondeterministic — identical tokens would mean the
    // first attempt's (possibly stale) JWT was reused on the retry.
    expect(calls[0].authorization).toBeDefined();
    expect(calls[1].authorization).not.toBe(calls[0].authorization);
  });

  it('exhausts retries on persistent 429 and surfaces the usual Apple error shape', async () => {
    const sleep = vi.spyOn(backoff, 'sleep').mockResolvedValue(undefined);
    const calls = mockFetchSequence([{ status: 429, body: rateLimitBody }]);

    const err = await resolveAppId(creds, 'com.x').catch((e: unknown) => e) as Error & { appleErrors?: unknown[]; httpStatus?: number };

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/Apple API error — RATE_LIMIT_EXCEEDED/);
    expect(err.httpStatus).toBe(429);
    expect(err.appleErrors).toHaveLength(1);
    expect(calls).toHaveLength(3); // initial attempt + 2 retries
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([1000, 4000]);
  });

  it('honors Retry-After in seconds and caps the wait at 30s', async () => {
    const sleep = vi.spyOn(backoff, 'sleep').mockResolvedValue(undefined);
    mockFetchSequence([
      { status: 429, body: rateLimitBody, retryAfter: '7' },
      { status: 429, body: rateLimitBody, retryAfter: '120' },
      { status: 200, body: appsBody },
    ]);

    const appId = await resolveAppId(creds, 'com.x');

    expect(appId).toBe('app1');
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([7000, 30_000]);
  });

  it('retries a transient 503 as well', async () => {
    const sleep = vi.spyOn(backoff, 'sleep').mockResolvedValue(undefined);
    const calls = mockFetchSequence([
      { status: 503, body: { errors: [] } },
      { status: 200, body: appsBody },
    ]);

    const appId = await resolveAppId(creds, 'com.x');

    expect(appId).toBe('app1');
    expect(calls).toHaveLength(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });
});

describe('findPricePoint — unit conversion', () => {
  it('matches USD price points given the target in cents (customerPrice is in dollars)', async () => {
    mockFetch([{
      match: (u) => u.includes('/pricePoints'),
      body: { data: [pricePoint('pp1', '3.99'), pricePoint('pp2', '4.99'), pricePoint('pp3', '5.99')] },
    }]);

    const result = await findPricePoint(creds, 'subscriptions', 'sub1', 'USA', 499, 'USD');
    expect(result.exact?.id).toBe('pp2');
  });

  it('ranks nearest tiers in smallest-unit space, not raw dollar distance', async () => {
    mockFetch([{
      match: (u) => u.includes('/pricePoints'),
      body: { data: [pricePoint('pp1', '0.99'), pricePoint('pp2', '4.99'), pricePoint('pp3', '99.99')] },
    }]);

    // Target 450 cents: nearest should be $4.99 (49¢ away), then $0.99, then $99.99
    const result = await findPricePoint(creds, 'subscriptions', 'sub1', 'USA', 450, 'USD');
    expect(result.exact).toBeNull();
    expect(result.nearest.map((p) => p.id)).toEqual(['pp2', 'pp1', 'pp3']);
  });

  it('matches zero-decimal currencies (KRW) without scaling', async () => {
    mockFetch([{
      match: (u) => u.includes('/pricePoints'),
      body: { data: [pricePoint('pp1', '4900'), pricePoint('pp2', '5900')] },
    }]);

    const result = await findPricePoint(creds, 'subscriptions', 'sub1', 'KOR', 4900, 'KRW');
    expect(result.exact?.id).toBe('pp1');
  });

  it('falls back to major-unit comparison for unmapped territories with no currency arg', async () => {
    // TWN is not in the territory→currency map; scaling by 100 would silently
    // break zero-decimal TWD matching for external callers (e.g. mimi-seed).
    mockFetch([{
      match: (u) => u.includes('/pricePoints'),
      body: { data: [pricePoint('pp1', '290'), pricePoint('pp2', '330')] },
    }]);

    const result = await findPricePoint(creds, 'subscriptions', 'sub1', 'TWN', 290);
    expect(result.exact?.id).toBe('pp1');
  });

  it('infers the currency from the territory when not passed (backward compat)', async () => {
    mockFetch([{
      match: (u) => u.includes('/pricePoints'),
      body: { data: [pricePoint('pp1', '4.99')] },
    }]);

    const result = await findPricePoint(creds, 'subscriptions', 'sub1', 'USA', 499);
    expect(result.exact?.id).toBe('pp1');
  });

  it('follows links.next pagination', async () => {
    const page2 = 'https://api.appstoreconnect.apple.com/v1/subscriptions/sub1/pricePoints?cursor=abc';
    mockFetch([
      {
        match: (u) => u.includes('cursor=abc'),
        body: { data: [pricePoint('pp2', '4.99')] },
      },
      {
        match: (u) => u.includes('/pricePoints'),
        body: { data: [pricePoint('pp1', '3.99')], links: { next: page2 } },
      },
    ]);

    const result = await findPricePoint(creds, 'subscriptions', 'sub1', 'USA', 499, 'USD');
    expect(result.exact?.id).toBe('pp2');
  });
});

describe('createSubscription — group handling', () => {
  it('reuses an existing subscription group with the same reference name', async () => {
    const calls = mockFetch([
      { match: (u, m) => u.includes('/subscriptionGroups') && m === 'GET', body: { data: [{ id: 'g_existing', attributes: { referenceName: 'Premium Group' } }] } },
      { match: (u, m) => u.endsWith('/subscriptions') && m === 'POST', body: { data: { id: 'sub_new', attributes: { productId: 'premium', state: 'MISSING_METADATA' } } } },
      { match: (u) => u.includes('/pricePoints'), body: { data: [pricePoint('pp1', '4.99')] } },
      { match: (u, m) => u.endsWith('/subscriptionPrices') && m === 'POST', body: { data: {} } },
    ]);

    const result = await createSubscription({
      productId: 'premium', name: 'Premium', price: 499, currency: 'USD', period: 'monthly',
      keyId: creds.keyId, issuerId: creds.issuerId, privateKey: creds.privateKey, appId: 'app1',
    });

    expect(result.success).toBe(true);
    expect(result.priceSet).toBe(true);
    // No POST /subscriptionGroups — the existing group was reused
    expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/subscriptionGroups'))).toBe(false);
    const subCreate = calls.find((c) => c.method === 'POST' && c.url.endsWith('/subscriptions'));
    expect((subCreate?.body as { data: { relationships: { group: { data: { id: string } } } } }).data.relationships.group.data.id).toBe('g_existing');
  });

  it('rolls back a freshly created group when the subscription create fails', async () => {
    const calls = mockFetch([
      { match: (u, m) => u.includes('/subscriptionGroups') && m === 'GET', body: { data: [] } },
      { match: (u, m) => u.endsWith('/subscriptionGroups') && m === 'POST', body: { data: { id: 'g_new' } } },
      {
        match: (u, m) => u.endsWith('/subscriptions') && m === 'POST',
        status: 409,
        body: { errors: [{ status: '409', code: 'ENTITY_ERROR.ATTRIBUTE.INVALID', title: 'bad productId' }] },
      },
      { match: (u, m) => u.includes('/subscriptionGroups/g_new') && m === 'DELETE', status: 204 },
    ]);

    const result = await createSubscription({
      productId: 'bad id', name: 'Premium', price: 499, currency: 'USD', period: 'monthly',
      keyId: creds.keyId, issuerId: creds.issuerId, privateKey: creds.privateKey, appId: 'app1',
    });

    expect(result.success).toBe(false);
    expect(calls.some((c) => c.method === 'DELETE' && c.url.includes('/subscriptionGroups/g_new'))).toBe(true);
  });

  it('reports priceError for an unsupported currency instead of failing silently', async () => {
    mockFetch([
      { match: (u, m) => u.includes('/subscriptionGroups') && m === 'GET', body: { data: [] } },
      { match: (u, m) => u.endsWith('/subscriptionGroups') && m === 'POST', body: { data: { id: 'g1' } } },
      { match: (u, m) => u.endsWith('/subscriptions') && m === 'POST', body: { data: { id: 'sub1', attributes: { productId: 'p', state: 'MISSING_METADATA' } } } },
    ]);

    const result = await createSubscription({
      productId: 'p', name: 'P', price: 1990, currency: 'BRL', period: 'monthly',
      keyId: creds.keyId, issuerId: creds.issuerId, privateKey: creds.privateKey, appId: 'app1',
    });

    expect(result.success).toBe(true);
    expect(result.priceSet).toBe(false);
    expect(result.priceError).toMatch(/Unsupported currency 'BRL'/);
  });
});

describe('createOneTimePurchase — price schedule', () => {
  it('includes the required baseTerritory relationship in the price schedule', async () => {
    const calls = mockFetch([
      { match: (u, m) => u.endsWith('/v2/inAppPurchases') && m === 'POST', body: { data: { id: 'iap1', attributes: {} } } },
      { match: (u) => u.includes('/pricePoints'), body: { data: [pricePoint('pp1', '4900')] } },
      { match: (u, m) => u.endsWith('/inAppPurchasePriceSchedules') && m === 'POST', body: { data: {} } },
    ]);

    const result = await createOneTimePurchase({
      productId: 'coins', name: 'Coins', price: 4900, currency: 'KRW', type: 'consumable',
      keyId: creds.keyId, issuerId: creds.issuerId, privateKey: creds.privateKey, appId: 'app1',
    });

    expect(result.priceSet).toBe(true);
    const schedule = calls.find((c) => c.url.endsWith('/inAppPurchasePriceSchedules'));
    const rel = (schedule?.body as { data: { relationships: Record<string, { data: { type: string; id: string } }> } }).data.relationships;
    expect(rel['baseTerritory']).toEqual({ data: { type: 'territories', id: 'KOR' } });
  });

  it('uses a `${...}` local id for the inline-created price', async () => {
    // A plain id ('p_0') is rejected with ENTITY_ERROR.INCLUDED.INVALID_ID and the
    // IAP is left priceless — the create still "succeeds", so only this pins it.
    const calls = mockFetch([
      { match: (u, m) => u.endsWith('/v2/inAppPurchases') && m === 'POST', body: { data: { id: 'iap1', attributes: {} } } },
      { match: (u) => u.includes('/pricePoints'), body: { data: [pricePoint('pp1', '4900')] } },
      { match: (u, m) => u.endsWith('/inAppPurchasePriceSchedules') && m === 'POST', body: { data: {} } },
    ]);

    await createOneTimePurchase({
      productId: 'coins', name: 'Coins', price: 4900, currency: 'KRW', type: 'consumable',
      keyId: creds.keyId, issuerId: creds.issuerId, privateKey: creds.privateKey, appId: 'app1',
    });

    const schedule = calls.find((c) => c.url.endsWith('/inAppPurchasePriceSchedules'));
    const body = schedule?.body as {
      data: { relationships: { manualPrices: { data: Array<{ id: string }> } } };
      included: Array<{ id: string }>;
    };
    expect(body.included[0].id).toMatch(/^\$\{.+\}$/);
    expect(body.data.relationships.manualPrices.data[0].id).toBe(body.included[0].id);
  });
});

describe('deleteProduct — empty-body success responses', () => {
  it('treats a 204 No Content DELETE as success', async () => {
    mockFetch([
      { match: (u, m) => u.includes('/inAppPurchasesV2?') && m === 'GET', body: { data: [{ id: 'iap1', attributes: { productId: 'coins', state: 'MISSING_METADATA' } }] } },
      { match: (u, m) => u.includes('/v2/inAppPurchases/iap1') && m === 'DELETE', status: 204 },
    ]);

    const result = await deleteProduct({
      productId: 'coins', productType: 'consumable',
      keyId: creds.keyId, issuerId: creds.issuerId, privateKey: creds.privateKey, appId: 'app1',
    });

    expect(result).toEqual({ success: true });
  });

  it('reports AUTH (not NOT_FOUND) when the lookup itself fails with 401', async () => {
    mockFetch([
      { match: (u, m) => u.includes('/inAppPurchasesV2') && m === 'GET', status: 401, body: { errors: [{ status: '401', code: 'NOT_AUTHORIZED', title: 'nope' }] } },
    ]);

    const result = await deleteProduct({
      productId: 'coins', productType: 'consumable',
      keyId: creds.keyId, issuerId: creds.issuerId, privateKey: creds.privateKey, appId: 'app1',
    });

    expect(result.success).toBe(false);
    expect(result.errorType).toBe('AUTH');
  });
});

describe('listProducts', () => {
  it('paginates both IAPs and subscription groups', async () => {
    const iapPage2 = 'https://api.appstoreconnect.apple.com/v1/apps/app1/inAppPurchasesV2?cursor=i2';
    mockFetch([
      { match: (u) => u.includes('cursor=i2'), body: { data: [{ id: 'iap2', attributes: { productId: 'p2', inAppPurchaseType: 'CONSUMABLE' } }] } },
      { match: (u) => u.includes('/inAppPurchasesV2'), body: { data: [{ id: 'iap1', attributes: { productId: 'p1', inAppPurchaseType: 'CONSUMABLE' } }], links: { next: iapPage2 } } },
      { match: (u) => u.includes('/subscriptionGroups'), body: { data: [], included: [{ id: 's1', type: 'subscriptions', attributes: { productId: 'sub1' } }] } },
    ]);

    const products = await listProducts({ keyId: creds.keyId, issuerId: creds.issuerId, privateKey: creds.privateKey, appId: 'app1' });
    expect(products.map((p) => p.productId).sort()).toEqual(['p1', 'p2', 'sub1']);
  });

  it('throws when both halves fail (auth error must not read as an empty catalog)', async () => {
    mockFetch([
      { match: () => true, status: 401, body: { errors: [{ status: '401', code: 'NOT_AUTHORIZED', title: 'nope' }] } },
    ]);

    await expect(listProducts({ keyId: creds.keyId, issuerId: creds.issuerId, privateKey: creds.privateKey, appId: 'app1' }))
      .rejects.toThrow(/Apple API error/);
  });
});
