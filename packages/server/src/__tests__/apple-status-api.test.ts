/**
 * Tests for fetchAppleSubscriptionStatus + the Apple webhook unknown-tx fallback.
 *
 * Covers:
 *   - status code 1..5 → SubscriptionStatus mapping
 *   - sandbox vs production host routing
 *   - missing API credentials → returns null (no throw)
 *   - HTTP error / empty data → returns null
 *   - webhook receives notification for unknown originalTransactionId →
 *     calls Status API + saves the returned record
 *   - webhook unknown tx without API creds → no fetch, just logs
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import express from 'express';
import { generateKeyPairSync } from 'crypto';
import type { OneSubServerConfig, SubscriptionInfo } from '@onesub/shared';
import { SUBSCRIPTION_STATUS } from '@onesub/shared';
import { fetchAppleSubscriptionStatus } from '../providers/apple.js';
import { createWebhookRouter } from '../routes/webhook.js';
import { InMemorySubscriptionStore, InMemoryPurchaseStore } from '../store.js';
import { isLocalhostUrl } from './test-utils.js';

// ── helpers ─────────────────────────────────────────────────────────────────

function makeJws(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'ES256' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.fakesig`;
}

let testEcKey: string;

beforeAll(() => {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  testEcKey = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
});

beforeEach(() => {
  vi.restoreAllMocks();
});

function appleConfigWithApi(overrides?: Partial<OneSubServerConfig['apple']>): NonNullable<OneSubServerConfig['apple']> {
  return {
    bundleId: 'com.example.app',
    skipJwsVerification: true,
    keyId: 'TESTKEY1',
    issuerId: '12345678-1234-1234-1234-123456789012',
    privateKey: testEcKey,
    ...overrides,
  };
}

/**
 * Mock global fetch with localhost pass-through. Apple Status API requests
 * resolve to the provided body; localhost (our test http server) is forwarded
 * to the real fetch implementation.
 */
function mockAppleStatusFetch(responseBody: unknown, opts?: { status?: number }) {
  const originalFetch = global.fetch;
  const calls: { url: string; method?: string; headers?: Record<string, string> }[] = [];
  vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
    if (isLocalhostUrl(url)) {
      return originalFetch(url, init);
    }
    const urlStr = String(url);
    calls.push({
      url: urlStr,
      method: init?.method,
      headers: init?.headers as Record<string, string>,
    });
    return {
      ok: (opts?.status ?? 200) < 400,
      status: opts?.status ?? 200,
      json: async () => responseBody,
      text: async () => JSON.stringify(responseBody),
    } as Response;
  });
  return calls;
}

function makeStatusResponse(opts: {
  originalTransactionId: string;
  status: 1 | 2 | 3 | 4 | 5;
  productId?: string;
  expiresDate?: number;
  autoRenewStatus?: 0 | 1;
}) {
  const tx = makeJws({
    bundleId: 'com.example.app',
    type: 'Auto-Renewable Subscription',
    productId: opts.productId ?? 'pro_monthly',
    transactionId: 'tx_inner',
    originalTransactionId: opts.originalTransactionId,
    purchaseDate: Date.now() - 30 * 86400000,
    originalPurchaseDate: Date.now() - 30 * 86400000,
    expiresDate: opts.expiresDate ?? Date.now() + 86400000,
  });
  const renewal = makeJws({ autoRenewStatus: opts.autoRenewStatus ?? 1 });
  return {
    bundleId: 'com.example.app',
    environment: 'Production',
    data: [{
      subscriptionGroupIdentifier: 'group_a',
      lastTransactions: [{
        originalTransactionId: opts.originalTransactionId,
        status: opts.status,
        signedTransactionInfo: tx,
        signedRenewalInfo: renewal,
      }],
    }],
  };
}

// ── fetchAppleSubscriptionStatus unit tests ─────────────────────────────────

describe('fetchAppleSubscriptionStatus', () => {
  it('returns null when API credentials are missing', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch');
    const result = await fetchAppleSubscriptionStatus('orig_xyz', {
      bundleId: 'com.example.app',
      skipJwsVerification: true,
    });
    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns null when mockMode is enabled', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch');
    const result = await fetchAppleSubscriptionStatus('orig_xyz', appleConfigWithApi({ mockMode: true }));
    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('GET .../inApps/v1/subscriptions/<id> with Bearer JWT', async () => {
    const calls = mockAppleStatusFetch(makeStatusResponse({
      originalTransactionId: 'orig_active',
      status: 1,
    }));

    await fetchAppleSubscriptionStatus('orig_active', appleConfigWithApi());

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('api.storekit.itunes.apple.com');
    expect(calls[0].url).toContain('/inApps/v1/subscriptions/orig_active');
    expect(calls[0].headers?.Authorization).toMatch(/^Bearer /);
  });

  it('routes to sandbox host when options.sandbox is true', async () => {
    const calls = mockAppleStatusFetch(makeStatusResponse({
      originalTransactionId: 'orig_sb',
      status: 1,
    }));

    await fetchAppleSubscriptionStatus('orig_sb', appleConfigWithApi(), { sandbox: true });

    expect(calls[0].url).toContain('api.storekit-sandbox.itunes.apple.com');
  });

  it('maps status code 1 → active', async () => {
    mockAppleStatusFetch(makeStatusResponse({ originalTransactionId: 'o1', status: 1 }));
    const result = await fetchAppleSubscriptionStatus('o1', appleConfigWithApi());
    expect(result?.status).toBe(SUBSCRIPTION_STATUS.ACTIVE);
  });

  it('maps status code 2 → expired', async () => {
    mockAppleStatusFetch(makeStatusResponse({ originalTransactionId: 'o2', status: 2 }));
    const result = await fetchAppleSubscriptionStatus('o2', appleConfigWithApi());
    expect(result?.status).toBe(SUBSCRIPTION_STATUS.EXPIRED);
  });

  it('maps status code 3 → on_hold (billing retry)', async () => {
    mockAppleStatusFetch(makeStatusResponse({ originalTransactionId: 'o3', status: 3 }));
    const result = await fetchAppleSubscriptionStatus('o3', appleConfigWithApi());
    expect(result?.status).toBe(SUBSCRIPTION_STATUS.ON_HOLD);
  });

  it('maps status code 4 → grace_period', async () => {
    mockAppleStatusFetch(makeStatusResponse({ originalTransactionId: 'o4', status: 4 }));
    const result = await fetchAppleSubscriptionStatus('o4', appleConfigWithApi());
    expect(result?.status).toBe(SUBSCRIPTION_STATUS.GRACE_PERIOD);
  });

  it('maps status code 5 → canceled (revoked)', async () => {
    mockAppleStatusFetch(makeStatusResponse({ originalTransactionId: 'o5', status: 5 }));
    const result = await fetchAppleSubscriptionStatus('o5', appleConfigWithApi());
    expect(result?.status).toBe(SUBSCRIPTION_STATUS.CANCELED);
  });

  it('reads autoRenewStatus from signedRenewalInfo for willRenew', async () => {
    mockAppleStatusFetch(makeStatusResponse({
      originalTransactionId: 'o_renew',
      status: 1,
      autoRenewStatus: 0,
    }));
    const result = await fetchAppleSubscriptionStatus('o_renew', appleConfigWithApi());
    expect(result?.willRenew).toBe(false);
  });

  it('returns null on HTTP 404', async () => {
    mockAppleStatusFetch({ errorCode: 4040010 }, { status: 404 });
    const result = await fetchAppleSubscriptionStatus('not_found', appleConfigWithApi());
    expect(result).toBeNull();
  });

  it('returns null when data array is empty', async () => {
    mockAppleStatusFetch({ bundleId: 'com.example.app', environment: 'Production', data: [] });
    const result = await fetchAppleSubscriptionStatus('orig_empty', appleConfigWithApi());
    expect(result).toBeNull();
  });

  it('returns null when matching originalTransactionId not in lastTransactions', async () => {
    mockAppleStatusFetch({
      bundleId: 'com.example.app',
      environment: 'Production',
      data: [{
        subscriptionGroupIdentifier: 'g',
        lastTransactions: [{
          originalTransactionId: 'different_id',
          status: 1,
          signedTransactionInfo: makeJws({ productId: 'p', expiresDate: Date.now() }),
        }],
      }],
    });
    const result = await fetchAppleSubscriptionStatus('expected_id', appleConfigWithApi());
    expect(result).toBeNull();
  });

  it('preserves originalTransactionId from caller (not from inner JWS)', async () => {
    mockAppleStatusFetch(makeStatusResponse({
      originalTransactionId: 'orig_caller',
      status: 1,
    }));
    const result = await fetchAppleSubscriptionStatus('orig_caller', appleConfigWithApi());
    expect(result?.originalTransactionId).toBe('orig_caller');
  });
});

// ── webhook unknown-transaction fallback ────────────────────────────────────

interface TestServer {
  request: (path: string, body: unknown) => Promise<{ status: number; body: unknown }>;
}

function buildAppleWebhookServer(config: OneSubServerConfig): {
  store: InMemorySubscriptionStore;
  server: TestServer;
} {
  const store = new InMemorySubscriptionStore();
  const purchaseStore = new InMemoryPurchaseStore();
  const app = express();
  app.use(express.json());
  app.use(createWebhookRouter(config, store, purchaseStore));
  return {
    store,
    server: {
      async request(path, body) {
        const httpServer = app.listen(0);
        const address = httpServer.address();
        const port = typeof address === 'object' && address ? address.port : 0;
        try {
          const resp = await fetch(`http://127.0.0.1:${port}${path}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
          const text = await resp.text();
          let parsed: unknown = text;
          try { parsed = JSON.parse(text); } catch { /* keep as text */ }
          return { status: resp.status, body: parsed };
        } finally {
          await new Promise<void>((resolve) => httpServer.close(() => resolve()));
        }
      },
    },
  };
}

function buildUnknownTxNotification(originalTransactionId: string, opts?: { sandbox?: boolean }): unknown {
  const signedTransactionInfo = makeJws({
    bundleId: 'com.example.app',
    type: 'Auto-Renewable Subscription',
    productId: 'pro_monthly',
    transactionId: 'tx_notify',
    originalTransactionId,
    purchaseDate: Date.now(),
    expiresDate: Date.now() + 86400000,
    environment: opts?.sandbox ? 'Sandbox' : 'Production',
  });
  return {
    signedPayload: makeJws({
      notificationType: 'DID_RENEW',
      data: {
        signedTransactionInfo,
        signedRenewalInfo: makeJws({ autoRenewStatus: 1 }),
      },
    }),
  };
}

describe('Apple webhook — unknown originalTransactionId fallback', () => {
  it('fetches from Status API and saves a placeholder record when API creds present', async () => {
    mockAppleStatusFetch(makeStatusResponse({
      originalTransactionId: 'orig_unknown',
      status: 1,
    }));

    const config: OneSubServerConfig = {
      apple: appleConfigWithApi(),
      database: { url: '' },
    };
    const { store, server } = buildAppleWebhookServer(config);

    const resp = await server.request('/onesub/webhook/apple', buildUnknownTxNotification('orig_unknown'));
    expect(resp.status).toBe(200);

    const saved = await store.getByTransactionId('orig_unknown');
    expect(saved).not.toBeNull();
    expect(saved?.status).toBe(SUBSCRIPTION_STATUS.ACTIVE);
    // userId is unknown at webhook time — placeholder is the originalTransactionId
    expect(saved?.userId).toBe('orig_unknown');
  });

  it('routes to sandbox host when notification environment is Sandbox', async () => {
    const calls = mockAppleStatusFetch(makeStatusResponse({
      originalTransactionId: 'orig_sb_unknown',
      status: 1,
    }));

    const config: OneSubServerConfig = {
      apple: appleConfigWithApi(),
      database: { url: '' },
    };
    const { server } = buildAppleWebhookServer(config);

    await server.request(
      '/onesub/webhook/apple',
      buildUnknownTxNotification('orig_sb_unknown', { sandbox: true }),
    );

    const apiCall = calls.find((c) => c.url.includes('/inApps/v1/subscriptions/'));
    expect(apiCall?.url).toContain('api.storekit-sandbox.itunes.apple.com');
  });

  it('does not call Status API when issuerId/keyId/privateKey are missing', async () => {
    const originalFetch = global.fetch;
    const outboundCalls: { url: string }[] = [];
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      if (isLocalhostUrl(url)) {
        return originalFetch(url, init);
      }
      outboundCalls.push({ url: String(url) });
      return { ok: true, status: 200, json: async () => ({}), text: async () => '' } as Response;
    });

    const config: OneSubServerConfig = {
      apple: { bundleId: 'com.example.app', skipJwsVerification: true }, // no API creds
      database: { url: '' },
    };
    const { store, server } = buildAppleWebhookServer(config);

    const resp = await server.request('/onesub/webhook/apple', buildUnknownTxNotification('orig_no_creds'));
    expect(resp.status).toBe(200);
    expect(await store.getByTransactionId('orig_no_creds')).toBeNull();
    expect(outboundCalls).toHaveLength(0);
  });

  it('does not overwrite an existing record (still the normal update path)', async () => {
    const originalFetch = global.fetch;
    const outboundCalls: { url: string }[] = [];
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      if (isLocalhostUrl(url)) {
        return originalFetch(url, init);
      }
      outboundCalls.push({ url: String(url) });
      return { ok: true, status: 200, json: async () => ({}), text: async () => '' } as Response;
    });

    const config: OneSubServerConfig = {
      apple: appleConfigWithApi(),
      database: { url: '' },
    };
    const { store, server } = buildAppleWebhookServer(config);

    const existing: SubscriptionInfo = {
      userId: 'real_user',
      productId: 'pro_monthly',
      platform: 'apple',
      status: SUBSCRIPTION_STATUS.ACTIVE,
      expiresAt: '2027-01-01T00:00:00.000Z',
      originalTransactionId: 'orig_known',
      purchasedAt: '2026-01-01T00:00:00.000Z',
      willRenew: true,
    };
    await store.save(existing);

    const resp = await server.request('/onesub/webhook/apple', buildUnknownTxNotification('orig_known'));
    expect(resp.status).toBe(200);

    // Existing record's userId preserved (not replaced with placeholder)
    expect((await store.getByTransactionId('orig_known'))?.userId).toBe('real_user');
    // No outbound Status API call since we already had the record
    expect(outboundCalls.find((c) => c.url.includes('/inApps/v1/subscriptions/'))).toBeUndefined();
  });
});
