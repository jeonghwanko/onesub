/**
 * SDK API helpers for entitlements — checkEntitlement / checkEntitlements.
 *
 * The Provider wiring (auto-refresh on subscribe/purchase, hasEntitlement,
 * refreshEntitlements) is integration territory and runs better against the
 * server's own test harness; here we cover only the pure HTTP helpers.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { checkEntitlement, checkEntitlements } from '../api.js';

beforeEach(() => {
  vi.restoreAllMocks();
});

function mockJsonResponse(status: number, body: unknown): Response {
  return {
    ok: status < 400,
    status,
    statusText: status === 200 ? 'OK' : status === 404 ? 'Not Found' : 'Error',
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

// ── checkEntitlement ────────────────────────────────────────────────────────

describe('checkEntitlement', () => {
  it('GETs /onesub/entitlement?userId=&id=', async () => {
    const calls: string[] = [];
    vi.spyOn(global, 'fetch').mockImplementation(async (url) => {
      calls.push(String(url));
      return mockJsonResponse(200, {
        id: 'premium',
        active: true,
        source: 'subscription',
        productId: 'pro_monthly',
        expiresAt: '2099-01-01T00:00:00Z',
      });
    });

    const result = await checkEntitlement('https://api.example.com', 'u_42', 'premium');

    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe(
      'https://api.example.com/onesub/entitlement?userId=u_42&id=premium',
    );
    expect(result.active).toBe(true);
    expect(result.productId).toBe('pro_monthly');
  });

  it('strips trailing slash from serverUrl', async () => {
    const calls: string[] = [];
    vi.spyOn(global, 'fetch').mockImplementation(async (url) => {
      calls.push(String(url));
      return mockJsonResponse(200, { id: 'premium', active: false, source: null });
    });

    await checkEntitlement('https://api.example.com/', 'u', 'premium');

    expect(calls[0]).toBe('https://api.example.com/onesub/entitlement?userId=u&id=premium');
  });

  it('URL-encodes userId and id', async () => {
    const calls: string[] = [];
    vi.spyOn(global, 'fetch').mockImplementation(async (url) => {
      calls.push(String(url));
      return mockJsonResponse(200, { id: 'pro mode', active: false, source: null });
    });

    await checkEntitlement('https://api.example.com', 'u with spaces', 'pro mode');

    expect(calls[0]).toContain('userId=u%20with%20spaces');
    expect(calls[0]).toContain('id=pro%20mode');
  });

  it('throws on 4xx/5xx (lets caller distinguish unknown id from "not entitled")', async () => {
    vi.spyOn(global, 'fetch').mockImplementation(async () =>
      mockJsonResponse(404, { errorCode: 'ENTITLEMENT_NOT_FOUND' }),
    );

    await expect(
      checkEntitlement('https://api.example.com', 'u', 'enterprise'),
    ).rejects.toThrow(/Entitlement check failed: 404/);
  });

  it('returns active=false (not throw) for normal "user has nothing" case', async () => {
    vi.spyOn(global, 'fetch').mockImplementation(async () =>
      mockJsonResponse(200, { id: 'premium', active: false, source: null }),
    );

    const result = await checkEntitlement('https://api.example.com', 'u_none', 'premium');
    expect(result.active).toBe(false);
    expect(result.source).toBeNull();
  });
});

// ── checkEntitlements ──────────────────────────────────────────────────────

describe('checkEntitlements (bulk)', () => {
  it('GETs /onesub/entitlements?userId= and returns the map', async () => {
    const calls: string[] = [];
    vi.spyOn(global, 'fetch').mockImplementation(async (url) => {
      calls.push(String(url));
      return mockJsonResponse(200, {
        entitlements: {
          premium: { active: true, source: 'subscription', productId: 'pro_monthly' },
          promode: { active: false, source: null },
        },
      });
    });

    const result = await checkEntitlements('https://api.example.com', 'u_bulk');

    expect(calls[0]).toBe('https://api.example.com/onesub/entitlements?userId=u_bulk');
    expect(result.entitlements.premium.active).toBe(true);
    expect(result.entitlements.promode.active).toBe(false);
  });

  it('returns empty map (NOT throw) when server has no entitlements configured (404)', async () => {
    // Server with no entitlements config returns 404 (router not mounted).
    // The SDK treats this as a valid runtime state, not an error — so the
    // host can mount the Provider before deciding on entitlement strategy.
    vi.spyOn(global, 'fetch').mockImplementation(async () =>
      mockJsonResponse(404, { error: 'Not Found' }),
    );

    const result = await checkEntitlements('https://api.example.com', 'u');
    expect(result.entitlements).toEqual({});
  });

  it('throws on 5xx (genuine server error)', async () => {
    vi.spyOn(global, 'fetch').mockImplementation(async () =>
      mockJsonResponse(500, { error: 'Internal' }),
    );

    await expect(checkEntitlements('https://api.example.com', 'u')).rejects.toThrow(
      /Entitlements bulk check failed: 500/,
    );
  });

  it('strips trailing slash from serverUrl', async () => {
    const calls: string[] = [];
    vi.spyOn(global, 'fetch').mockImplementation(async (url) => {
      calls.push(String(url));
      return mockJsonResponse(200, { entitlements: {} });
    });

    await checkEntitlements('https://api.example.com/', 'u');
    expect(calls[0]).toBe('https://api.example.com/onesub/entitlements?userId=u');
  });
});
