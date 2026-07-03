import { describe, it, expect, vi, afterEach } from 'vitest';
import { runSimulatePurchase } from '../tools/simulate-purchase.js';
import { runSimulateWebhook } from '../tools/simulate-webhook.js';
import { runInspectState } from '../tools/inspect-state.js';
import { runViewSubscribers } from '../tools/view-subscribers.js';

function text(result: { content: Array<{ type: 'text'; text: string }> }): string {
  return result.content.map((c) => c.text).join('\n');
}

/**
 * Mock `globalThis.fetch` with a per-URL response map. Returns the mock so
 * tests can inspect .mock.calls.
 */
function mockFetch(responses: Record<string, { status: number; body: string | object }>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({ url, init });
    const matched = Object.entries(responses).find(([k]) => url.includes(k));
    if (!matched) throw new Error(`no mock for ${url}`);
    const { status, body } = matched[1];
    const rawBody = typeof body === 'string' ? body : JSON.stringify(body);
    return new Response(rawBody, { status, headers: { 'Content-Type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fn);
  return { fn, calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// onesub_simulate_purchase
// ---------------------------------------------------------------------------
describe('simulate_purchase', () => {
  it('builds MOCK_VALID receipt for "new" scenario and routes to /onesub/purchase/validate', async () => {
    const { calls } = mockFetch({
      '/onesub/purchase/validate': {
        status: 200,
        body: { valid: true, purchase: { productId: 'premium' }, action: 'new' },
      },
    });

    const out = await runSimulatePurchase({
      serverUrl: 'http://localhost:4100',
      userId: 'u1',
      productId: 'premium',
      platform: 'apple',
      type: 'non_consumable',
      scenario: 'new',
    });

    expect(calls).toHaveLength(1);
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.receipt).toMatch(/^MOCK_VALID_premium_/);
    expect(body.type).toBe('non_consumable');
    expect(calls[0]!.url).toContain('/onesub/purchase/validate');

    const md = text(out);
    expect(md).toContain('HTTP 200 ✓');
    expect(md).toContain('action:');
    expect(md).toContain('new');
  });

  it('builds MOCK_REVOKED receipt for "revoked" scenario and flags 422 as expected', async () => {
    const { calls } = mockFetch({
      '/onesub/purchase/validate': {
        status: 422,
        body: { valid: false, purchase: null, error: 'Receipt validation failed', errorCode: 'RECEIPT_VALIDATION_FAILED' },
      },
    });

    const out = await runSimulatePurchase({
      serverUrl: 'http://localhost:4100',
      userId: 'u1',
      productId: 'premium',
      platform: 'apple',
      type: 'non_consumable',
      scenario: 'revoked',
    });

    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.receipt).toMatch(/^MOCK_REVOKED_/);

    const md = text(out);
    expect(md).toContain('HTTP 422');
    expect(md).toContain('RECEIPT_VALIDATION_FAILED');
    // Non-2xx bodies must be parsed (not passed through as a raw string) so
    // the errorCode highlight renders.
    expect(md).toContain('**errorCode:** `RECEIPT_VALIDATION_FAILED`');
    expect(md).not.toContain('Unexpected:'); // 422 for revoked is expected
  });

  it('subscription type routes to /onesub/validate, not /onesub/purchase/validate', async () => {
    const { calls } = mockFetch({
      '/onesub/validate': { status: 200, body: { valid: true, subscription: {} } },
    });

    await runSimulatePurchase({
      serverUrl: 'http://localhost:4100',
      userId: 'u1',
      productId: 'pro',
      platform: 'google',
      type: 'subscription',
      scenario: 'new',
    });

    expect(calls[0]!.url).toContain('/onesub/validate');
    expect(calls[0]!.url).not.toContain('/onesub/purchase/validate');
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.type).toBeUndefined();
  });

  it('flags 200 as unexpected when scenario is a failure scenario (sanity check)', async () => {
    mockFetch({
      '/onesub/purchase/validate': { status: 200, body: { valid: true } },
    });
    const out = await runSimulatePurchase({
      serverUrl: 'http://localhost:4100',
      userId: 'u1',
      productId: 'p',
      platform: 'apple',
      type: 'non_consumable',
      scenario: 'revoked',
    });
    expect(text(out)).toContain('Unexpected:');
  });

  it('network error produces "connection failed" output with dev server hint', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('fetch failed'); }));
    const out = await runSimulatePurchase({
      serverUrl: 'http://localhost:4100',
      userId: 'u1',
      productId: 'p',
      platform: 'apple',
      type: 'non_consumable',
      scenario: 'new',
    });
    expect(text(out)).toContain('connection failed');
    expect(text(out)).toContain('npx @onesub/cli dev');
  });
});

// ---------------------------------------------------------------------------
// onesub_simulate_webhook
// ---------------------------------------------------------------------------
describe('simulate_webhook', () => {
  it('parses non-2xx JSON body and renders the INVALID_SIGNED_PAYLOAD hint', async () => {
    mockFetch({
      '/onesub/webhook/apple': {
        status: 422,
        body: { received: false, error: 'JWS verification failed', errorCode: 'INVALID_SIGNED_PAYLOAD' },
      },
    });

    const out = await runSimulateWebhook({
      serverUrl: 'http://localhost:4100',
      platform: 'apple',
      notificationType: 'DID_RENEW',
      transactionId: 'orig_tx_1',
      productId: 'pro_monthly',
      bundleId: 'com.example.app',
      packageName: 'com.example.app',
      expiresInDays: 30,
    });

    const md = text(out);
    expect(md).toContain('HTTP 422');
    expect(md).toContain('**errorCode:** `INVALID_SIGNED_PAYLOAD`');
    expect(md).toContain('skipJwsVerification');
  });

  it('renders expected status hint on 2xx', async () => {
    mockFetch({
      '/onesub/webhook/apple': { status: 200, body: { received: true } },
    });

    const out = await runSimulateWebhook({
      serverUrl: 'http://localhost:4100',
      platform: 'apple',
      notificationType: 'EXPIRED',
      transactionId: 'orig_tx_1',
      productId: 'pro_monthly',
      bundleId: 'com.example.app',
      packageName: 'com.example.app',
      expiresInDays: 30,
    });

    const md = text(out);
    expect(md).toContain('HTTP 200 ✓');
    expect(md).toContain('Expected status after this notification:');
    expect(md).toContain('`expired`');
  });
});

// ---------------------------------------------------------------------------
// onesub_inspect_state
// ---------------------------------------------------------------------------
describe('inspect_state', () => {
  it('renders subscription and purchases side-by-side', async () => {
    mockFetch({
      '/onesub/status': {
        status: 200,
        body: {
          active: true,
          subscription: {
            userId: 'u1',
            productId: 'pro_monthly',
            platform: 'apple',
            status: 'active',
            expiresAt: '2026-05-01T00:00:00.000Z',
            purchasedAt: '2026-04-01T00:00:00.000Z',
            originalTransactionId: 'mock_apple_orig_abc',
            willRenew: true,
          },
        },
      },
      '/onesub/purchase/status': {
        status: 200,
        body: {
          purchases: [
            { userId: 'u1', productId: 'premium', platform: 'apple', type: 'non_consumable', transactionId: 'tx_1', purchasedAt: '2026-04-02T00:00:00.000Z', quantity: 1 },
            { userId: 'u1', productId: 'credits_100', platform: 'apple', type: 'consumable', transactionId: 'tx_2', purchasedAt: '2026-04-02T01:00:00.000Z', quantity: 1 },
          ],
        },
      },
    });

    const out = await runInspectState({ serverUrl: 'http://localhost:4100', userId: 'u1' });
    const md = text(out);

    expect(md).toContain('## Subscription');
    expect(md).toContain('pro_monthly');
    expect(md).toContain('Will Renew');
    expect(md).toContain('## One-time purchases');
    expect(md).toContain('premium');
    expect(md).toContain('credits_100');
    expect(md).toContain('Total: **2**');
  });

  it('says "No active subscription" when status.active is false', async () => {
    mockFetch({
      '/onesub/status': { status: 200, body: { active: false, subscription: null } },
      '/onesub/purchase/status': { status: 200, body: { purchases: [] } },
    });
    const out = await runInspectState({ serverUrl: 'http://localhost:4100', userId: 'nouser' });
    const md = text(out);
    expect(md).toContain('No active subscription');
    expect(md).toContain('No purchases');
  });

  it('surfaces connection failure with dev server hint when fetch throws on status call', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED 127.0.0.1:4100'); }));
    const out = await runInspectState({ serverUrl: 'http://localhost:4100', userId: 'u1' });
    const md = text(out);
    expect(md).toContain('Connection failed');
    expect(md).toContain('npx @onesub/cli dev');
  });
});

// ---------------------------------------------------------------------------
// onesub_view_subscribers
// ---------------------------------------------------------------------------
describe('view_subscribers', () => {
  const METRICS_BODY = {
    total: 15,
    activeSubscriptions: 12,
    gracePeriodSubscriptions: 1,
    nonConsumablePurchases: 3,
    byProduct: { pro_monthly: 12 },
    byProductPurchases: { lifetime_pass: 3 },
    byPlatform: { apple: 10, google: 5 },
  };

  it('with adminSecret and no userId fetches metrics + list with x-admin-secret and renders counts', async () => {
    const { calls } = mockFetch({
      '/onesub/metrics/active': { status: 200, body: METRICS_BODY },
      '/onesub/admin/subscriptions': {
        status: 200,
        body: {
          items: [
            { userId: 'u1', productId: 'pro_monthly', platform: 'apple', status: 'active', expiresAt: '2026-08-01T00:00:00.000Z', purchasedAt: '2026-07-01T00:00:00.000Z', originalTransactionId: 'tx_1', willRenew: true },
            { userId: 'u2', productId: 'pro_monthly', platform: 'google', status: 'grace_period', expiresAt: '2026-07-05T00:00:00.000Z', purchasedAt: '2026-06-05T00:00:00.000Z', originalTransactionId: 'tx_2', willRenew: true },
          ],
          total: 12,
          limit: 10,
          offset: 0,
        },
      },
    });

    const out = await runViewSubscribers({ serverUrl: 'http://localhost:4100', adminSecret: 's3cret' });
    const md = text(out);

    const metricsCall = calls.find((c) => c.url.includes('/onesub/metrics/active'));
    const listCall = calls.find((c) => c.url.includes('/onesub/admin/subscriptions'));
    expect(metricsCall).toBeDefined();
    expect((metricsCall!.init.headers as Record<string, string>)['x-admin-secret']).toBe('s3cret');
    expect(listCall).toBeDefined();
    expect(listCall!.url).toContain('limit=10');
    expect((listCall!.init.headers as Record<string, string>)['x-admin-secret']).toBe('s3cret');

    expect(md).toContain('| Total entitled users | 15 |');
    expect(md).toContain('| Active subscriptions | 12 |');
    expect(md).toContain('| — in grace period | 1 |');
    expect(md).toContain('| Lifetime (non-consumable) purchases | 3 |');
    expect(md).toContain('`pro_monthly` ×12');
    expect(md).toContain('`lifetime_pass` ×3');
    expect(md).toContain('`apple` ×10');
    // recent-subscriptions table: productId, status, expiresAt
    expect(md).toContain('| `pro_monthly` | active | 2026-08-01T00:00:00.000Z |');
    expect(md).toContain('| `pro_monthly` | grace_period | 2026-07-05T00:00:00.000Z |');
    expect(md).toContain('first 2 of 12');
  });

  it('degrades to counts-only when the subscriptions list call fails', async () => {
    mockFetch({
      '/onesub/metrics/active': { status: 200, body: METRICS_BODY },
      '/onesub/admin/subscriptions': { status: 500, body: { error: 'boom', errorCode: 'STORE_ERROR' } },
    });

    const out = await runViewSubscribers({ serverUrl: 'http://localhost:4100', adminSecret: 's3cret' });
    const md = text(out);

    expect(md).toContain('| Total entitled users | 15 |');
    expect(md).toContain('Subscription list unavailable');
  });

  it('renders invalid-secret guidance when metrics returns 401', async () => {
    mockFetch({
      '/onesub/metrics/active': {
        status: 401,
        body: { error: 'INVALID_ADMIN_SECRET', errorCode: 'INVALID_ADMIN_SECRET' },
      },
    });

    const out = await runViewSubscribers({ serverUrl: 'http://localhost:4100', adminSecret: 'wrong' });
    const md = text(out);

    expect(md).toContain('HTTP Status:** 401');
    expect(md).toContain('`adminSecret` was rejected');
    expect(md).toContain('config.adminSecret');
  });

  it('without adminSecret and no userId renders guidance naming the endpoints and the adminSecret arg — no fetch', async () => {
    const { fn } = mockFetch({});

    const out = await runViewSubscribers({ serverUrl: 'http://localhost:4100' });
    const md = text(out);

    expect(fn).not.toHaveBeenCalled();
    expect(md).toContain('/onesub/metrics/active');
    expect(md).toContain('/onesub/admin/subscriptions');
    expect(md).toContain('adminSecret');
    expect(md).toContain('x-admin-secret');
    // Stale claims must be gone
    expect(md).not.toContain('does not expose');
    expect(md).not.toContain('database directly');
  });

  it('per-user path still queries /onesub/status without any secret header', async () => {
    const { calls } = mockFetch({
      '/onesub/status': {
        status: 200,
        body: {
          active: true,
          subscription: {
            productId: 'pro_monthly',
            platform: 'apple',
            status: 'active',
            willRenew: true,
            purchasedAt: '2026-06-01T00:00:00.000Z',
            expiresAt: '2026-08-01T00:00:00.000Z',
            originalTransactionId: 'tx_1',
          },
        },
      },
    });

    const out = await runViewSubscribers({ serverUrl: 'http://localhost:4100', userId: 'u1' });
    const md = text(out);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain('/onesub/status?userId=u1');
    expect((calls[0]!.init.headers as Record<string, string>)['x-admin-secret']).toBeUndefined();
    expect(md).toContain('**Active:** YES');
    expect(md).toContain('pro_monthly');
  });
});
