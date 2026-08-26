import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '../../lib/onesub-client';

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init.headers },
  });
}

function stubFetch(response: Response): ReturnType<typeof vi.fn<typeof fetch>> {
  const mock = vi.fn<typeof fetch>().mockResolvedValue(response);
  vi.stubGlobal('fetch', mock);
  return mock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('dashboard onesub client', () => {
  it('keeps the admin secret server-side and disables response caching', async () => {
    const fetchMock = stubFetch(jsonResponse({ total: 0 }));
    const client = createClient('https://onesub.example.test/', 'top-secret');

    await client.getActiveMetrics();

    expect(fetchMock).toHaveBeenCalledWith('https://onesub.example.test/onesub/metrics/active', {
      headers: {
        'X-Admin-Secret': 'top-secret',
        'Content-Type': 'application/json',
      },
      cache: 'no-store',
    });
  });

  it('encodes subscription filters without allowing path or query injection', async () => {
    const fetchMock = stubFetch(jsonResponse({ items: [], total: 0 }));
    const client = createClient('https://onesub.example.test', 'secret');

    await client.listSubscriptions({
      userId: 'alice+bob@example.test',
      productId: 'pro/monthly',
      status: 'active',
      platform: 'apple',
      limit: 50,
      offset: 10,
    });

    const [rawUrl] = fetchMock.mock.calls[0] ?? [];
    const url = new URL(String(rawUrl));
    expect(url.pathname).toBe('/onesub/admin/subscriptions');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      userId: 'alice+bob@example.test',
      productId: 'pro/monthly',
      status: 'active',
      platform: 'apple',
      limit: '50',
      offset: '10',
    });
  });

  it('sends destructive admin actions with an explicit method and JSON body', async () => {
    const fetchMock = stubFetch(jsonResponse({ ok: true, deleted: 1 }));
    const client = createClient('https://onesub.example.test', 'secret');

    await client.deletePurchases('user/one', 'premium pass');

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('https://onesub.example.test/onesub/purchase/admin/user%2Fone/premium%20pass');
    expect(init).toEqual(expect.objectContaining({ method: 'DELETE', cache: 'no-store' }));
    expect(init).not.toHaveProperty('body');
  });

  it('preserves the upstream status and response body in write errors', async () => {
    stubFetch(new Response('TRANSACTION_NOT_FOUND', { status: 404, statusText: 'Not Found' }));
    const client = createClient('https://onesub.example.test', 'secret');

    await expect(client.transferPurchase('missing', 'new-owner')).rejects.toEqual(
      expect.objectContaining({
        name: 'OneSubFetchError',
        status: 404,
        message: expect.stringContaining('TRANSACTION_NOT_FOUND'),
      }),
    );
  });
});
