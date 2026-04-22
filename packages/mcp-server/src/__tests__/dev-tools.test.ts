import { describe, it, expect, vi, afterEach } from 'vitest';
import { runSimulatePurchase } from '../tools/simulate-purchase.js';
import { runInspectState } from '../tools/inspect-state.js';

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
