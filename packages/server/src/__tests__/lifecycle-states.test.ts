/**
 * Lifecycle state tests — grace_period / on_hold introduced as first-class
 * SubscriptionStatus values.
 *
 * Covers:
 *   - Apple webhook: DID_FAIL_TO_RENEW (subtype GRACE_PERIOD vs none), GRACE_PERIOD_EXPIRED
 *   - Google webhook: SUBSCRIPTION_IN_GRACE_PERIOD, SUBSCRIPTION_ON_HOLD
 *   - status route: active=true for grace_period, active=false for on_hold
 *   - CONSUMPTION_REQUEST: invokes consumptionInfoProvider then PUTs to Apple
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import express from 'express';
import { generateKeyPairSync } from 'crypto';
import type { OneSubServerConfig, SubscriptionInfo } from '@onesub/shared';
import { SUBSCRIPTION_STATUS } from '@onesub/shared';
import { createWebhookRouter } from '../routes/webhook.js';
import { createStatusRouter } from '../routes/status.js';
import { InMemorySubscriptionStore, InMemoryPurchaseStore } from '../store.js';

// ── helpers ─────────────────────────────────────────────────────────────────

function makeJws(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'ES256' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.fakesig`;
}

interface TestServer {
  request: (method: 'POST' | 'GET', path: string, body?: unknown) => Promise<{ status: number; body: unknown }>;
}

function spinUp(handler: express.Express): TestServer {
  return {
    async request(method, path, body) {
      const server = handler.listen(0);
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      try {
        const url = `http://127.0.0.1:${port}${path}`;
        const init: RequestInit = { method };
        if (body !== undefined) {
          init.headers = { 'Content-Type': 'application/json' };
          init.body = JSON.stringify(body);
        }
        const resp = await fetch(url, init);
        const text = await resp.text();
        let parsed: unknown = text;
        try { parsed = JSON.parse(text); } catch { /* keep as text */ }
        return { status: resp.status, body: parsed };
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  };
}

function buildAppleWebhookServer(config: OneSubServerConfig): {
  store: InMemorySubscriptionStore;
  purchaseStore: InMemoryPurchaseStore;
  server: TestServer;
} {
  const store = new InMemorySubscriptionStore();
  const purchaseStore = new InMemoryPurchaseStore();
  const app = express();
  app.use(express.json());
  app.use(createWebhookRouter(config, store, purchaseStore));
  return { store, purchaseStore, server: spinUp(app) };
}

function buildGoogleWebhookServer(config: OneSubServerConfig): {
  store: InMemorySubscriptionStore;
  server: TestServer;
} {
  const store = new InMemorySubscriptionStore();
  const purchaseStore = new InMemoryPurchaseStore();
  const app = express();
  app.use(express.json());
  app.use(createWebhookRouter(config, store, purchaseStore));
  return { store, server: spinUp(app) };
}

function buildStatusServer(): { store: InMemorySubscriptionStore; server: TestServer } {
  const store = new InMemorySubscriptionStore();
  const app = express();
  app.use(express.json());
  app.use(createStatusRouter(store));
  return { store, server: spinUp(app) };
}

const sampleSub = (overrides?: Partial<SubscriptionInfo>): SubscriptionInfo => ({
  userId: 'user_x',
  productId: 'pro_monthly',
  platform: 'apple',
  status: 'active',
  expiresAt: '2027-01-01T00:00:00.000Z',
  originalTransactionId: 'orig_x',
  purchasedAt: '2026-01-01T00:00:00.000Z',
  willRenew: true,
  ...overrides,
});

function appleSubscriptionTx(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    bundleId: 'com.example.app',
    type: 'Auto-Renewable Subscription',
    productId: 'pro_monthly',
    transactionId: 'tx_sub_1',
    originalTransactionId: 'orig_apple_sub',
    purchaseDate: Date.now(),
    expiresDate: Date.now() + 86400000,
    ...overrides,
  };
}

// ── Apple subtype mapping ───────────────────────────────────────────────────

describe('Apple webhook — DID_FAIL_TO_RENEW + GRACE_PERIOD_EXPIRED', () => {
  let store: InMemorySubscriptionStore;
  let server: TestServer;
  const config: OneSubServerConfig = {
    apple: { bundleId: 'com.example.app', skipJwsVerification: true },
    database: { url: '' },
  };

  beforeEach(() => {
    const built = buildAppleWebhookServer(config);
    store = built.store;
    server = built.server;
  });

  async function postApple(notificationType: string, subtype?: string) {
    const signedTransactionInfo = makeJws(appleSubscriptionTx());
    const payload: Record<string, unknown> = {
      notificationType,
      data: { signedTransactionInfo, signedRenewalInfo: makeJws({}) },
    };
    if (subtype) payload.subtype = subtype;
    const signedPayload = makeJws(payload);
    return server.request('POST', '/onesub/webhook/apple', { signedPayload });
  }

  it('DID_FAIL_TO_RENEW + subtype GRACE_PERIOD → grace_period', async () => {
    await store.save(sampleSub({ originalTransactionId: 'orig_apple_sub' }));
    const resp = await postApple('DID_FAIL_TO_RENEW', 'GRACE_PERIOD');
    expect(resp.status).toBe(200);
    expect((await store.getByTransactionId('orig_apple_sub'))?.status).toBe(
      SUBSCRIPTION_STATUS.GRACE_PERIOD,
    );
  });

  it('DID_FAIL_TO_RENEW (no subtype) → on_hold', async () => {
    await store.save(sampleSub({ originalTransactionId: 'orig_apple_sub' }));
    const resp = await postApple('DID_FAIL_TO_RENEW');
    expect(resp.status).toBe(200);
    expect((await store.getByTransactionId('orig_apple_sub'))?.status).toBe(
      SUBSCRIPTION_STATUS.ON_HOLD,
    );
  });

  it('GRACE_PERIOD_EXPIRED → on_hold (not expired — billing retry continues)', async () => {
    await store.save(sampleSub({ originalTransactionId: 'orig_apple_sub' }));
    const resp = await postApple('GRACE_PERIOD_EXPIRED');
    expect(resp.status).toBe(200);
    expect((await store.getByTransactionId('orig_apple_sub'))?.status).toBe(
      SUBSCRIPTION_STATUS.ON_HOLD,
    );
  });

  it('EXPIRED → expired (terminal)', async () => {
    await store.save(sampleSub({ originalTransactionId: 'orig_apple_sub' }));
    const resp = await postApple('EXPIRED');
    expect(resp.status).toBe(200);
    expect((await store.getByTransactionId('orig_apple_sub'))?.status).toBe(
      SUBSCRIPTION_STATUS.EXPIRED,
    );
  });
});

// ── Google IN_GRACE_PERIOD / ON_HOLD ────────────────────────────────────────

function googlePushBody(notificationType: number) {
  const json = JSON.stringify({
    version: '1.0',
    packageName: 'com.example.app',
    eventTimeMillis: String(Date.now()),
    subscriptionNotification: {
      version: '1.0',
      notificationType,
      purchaseToken: 'tok_google_sub',
      subscriptionId: 'pro_monthly',
    },
  });
  return {
    message: { data: Buffer.from(json).toString('base64'), messageId: '1' },
    subscription: 'projects/x/subscriptions/y',
  };
}

describe('Google webhook — IN_GRACE_PERIOD / ON_HOLD', () => {
  let store: InMemorySubscriptionStore;
  let server: TestServer;
  const config: OneSubServerConfig = {
    google: { packageName: 'com.example.app' }, // no serviceAccountKey → no Play API re-fetch
    database: { url: '' },
  };

  beforeEach(() => {
    const built = buildGoogleWebhookServer(config);
    store = built.store;
    server = built.server;
  });

  it('IN_GRACE_PERIOD (6) → grace_period', async () => {
    await store.save(sampleSub({
      platform: 'google',
      originalTransactionId: 'tok_google_sub',
    }));
    const resp = await server.request('POST', '/onesub/webhook/google', googlePushBody(6));
    expect(resp.status).toBe(200);
    expect((await store.getByTransactionId('tok_google_sub'))?.status).toBe(
      SUBSCRIPTION_STATUS.GRACE_PERIOD,
    );
  });

  it('ON_HOLD (5) → on_hold', async () => {
    await store.save(sampleSub({
      platform: 'google',
      originalTransactionId: 'tok_google_sub',
    }));
    const resp = await server.request('POST', '/onesub/webhook/google', googlePushBody(5));
    expect(resp.status).toBe(200);
    expect((await store.getByTransactionId('tok_google_sub'))?.status).toBe(
      SUBSCRIPTION_STATUS.ON_HOLD,
    );
  });
});

// ── status route entitlement semantics ──────────────────────────────────────

describe('status route — entitlement for new states', () => {
  let store: InMemorySubscriptionStore;
  let server: TestServer;

  beforeEach(() => {
    const built = buildStatusServer();
    store = built.store;
    server = built.server;
  });

  it('grace_period → active: true (entitlement still valid)', async () => {
    await store.save(sampleSub({ userId: 'u_grace', status: 'grace_period' }));
    const resp = await server.request('GET', '/onesub/status?userId=u_grace');
    expect(resp.status).toBe(200);
    expect((resp.body as { active: boolean }).active).toBe(true);
  });

  it('on_hold → active: false (entitlement revoked)', async () => {
    await store.save(sampleSub({ userId: 'u_hold', status: 'on_hold' }));
    const resp = await server.request('GET', '/onesub/status?userId=u_hold');
    expect(resp.status).toBe(200);
    expect((resp.body as { active: boolean }).active).toBe(false);
  });

  it('expired → active: false', async () => {
    await store.save(sampleSub({ userId: 'u_exp', status: 'expired' }));
    const resp = await server.request('GET', '/onesub/status?userId=u_exp');
    expect((resp.body as { active: boolean }).active).toBe(false);
  });
});

// ── CONSUMPTION_REQUEST → consumptionInfoProvider → Apple PUT ───────────────

describe('Apple webhook — CONSUMPTION_REQUEST', () => {
  let testEcKey: string;

  beforeAll(() => {
    // Generate a real EC P-256 key for the JWT signing path.
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    testEcKey = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
  });

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('invokes consumptionInfoProvider with context, then PUTs body to Apple consumption endpoint', async () => {
    const originalFetch = global.fetch;
    const fetchCalls: { url: string; method?: string; body?: unknown; headers?: Record<string, string> }[] = [];
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = String(url);
      // Pass-through localhost — that's our own test server.
      if (urlStr.startsWith('http://127.0.0.1') || urlStr.startsWith('http://localhost')) {
        return originalFetch(url, init);
      }
      fetchCalls.push({
        url: urlStr,
        method: init?.method,
        body: init?.body,
        headers: init?.headers as Record<string, string>,
      });
      return { ok: true, json: async () => ({}), text: async () => '' } as Response;
    });

    const provider = vi.fn(async () => ({
      customerConsented: true,
      consumptionStatus: 3 as const,
      deliveryStatus: 1 as const,
      refundPreference: 2 as const,
    }));

    const config: OneSubServerConfig = {
      apple: {
        bundleId: 'com.example.app',
        skipJwsVerification: true,
        keyId: 'TESTKEY1',
        issuerId: '12345678-1234-1234-1234-123456789012',
        privateKey: testEcKey,
        consumptionInfoProvider: provider,
      },
      database: { url: '' },
    };
    const { server } = buildAppleWebhookServer(config);

    const signedTransactionInfo = makeJws({
      bundleId: 'com.example.app',
      type: 'Consumable',
      productId: 'credits_100',
      transactionId: 'tx_consume_refund',
      originalTransactionId: 'orig_consume_refund',
      purchaseDate: Date.now(),
      environment: 'Production',
    });
    const signedPayload = makeJws({
      notificationType: 'CONSUMPTION_REQUEST',
      data: { signedTransactionInfo, signedRenewalInfo: makeJws({}) },
    });

    const resp = await server.request('POST', '/onesub/webhook/apple', { signedPayload });
    expect(resp.status).toBe(200);

    // Provider runs in fire-and-forget — give the microtask queue a tick.
    await new Promise((r) => setTimeout(r, 50));

    expect(provider).toHaveBeenCalledWith({
      transactionId: 'tx_consume_refund',
      originalTransactionId: 'orig_consume_refund',
      productId: 'credits_100',
      bundleId: 'com.example.app',
      environment: 'Production',
    });

    const putCall = fetchCalls.find((c) => c.method === 'PUT');
    expect(putCall).toBeDefined();
    expect(putCall?.url).toContain('api.storekit.itunes.apple.com');
    expect(putCall?.url).toContain('/inApps/v1/transactions/consumption/tx_consume_refund');
    expect(putCall?.headers?.Authorization).toMatch(/^Bearer /);
    expect(JSON.parse(String(putCall?.body))).toMatchObject({
      customerConsented: true,
      consumptionStatus: 3,
      deliveryStatus: 1,
      refundPreference: 2,
    });
  });

  it('routes Sandbox-environment notifications to the sandbox host', async () => {
    const originalFetch = global.fetch;
    const fetchCalls: { url: string; method?: string }[] = [];
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = String(url);
      if (urlStr.startsWith('http://127.0.0.1') || urlStr.startsWith('http://localhost')) {
        return originalFetch(url, init);
      }
      fetchCalls.push({ url: urlStr, method: init?.method });
      return { ok: true, json: async () => ({}), text: async () => '' } as Response;
    });

    const config: OneSubServerConfig = {
      apple: {
        bundleId: 'com.example.app',
        skipJwsVerification: true,
        keyId: 'TESTKEY1',
        issuerId: '12345678-1234-1234-1234-123456789012',
        privateKey: testEcKey,
        consumptionInfoProvider: async () => ({
          customerConsented: true,
          consumptionStatus: 1,
          deliveryStatus: 1,
        }),
      },
      database: { url: '' },
    };
    const { server } = buildAppleWebhookServer(config);

    const signedTransactionInfo = makeJws({
      bundleId: 'com.example.app',
      type: 'Consumable',
      productId: 'credits_100',
      transactionId: 'tx_sandbox',
      originalTransactionId: 'orig_sandbox',
      purchaseDate: Date.now(),
      environment: 'Sandbox',
    });
    const signedPayload = makeJws({
      notificationType: 'CONSUMPTION_REQUEST',
      data: { signedTransactionInfo, signedRenewalInfo: makeJws({}), environment: 'Sandbox' },
    });

    await server.request('POST', '/onesub/webhook/apple', { signedPayload });
    await new Promise((r) => setTimeout(r, 50));

    const putCall = fetchCalls.find((c) => c.method === 'PUT');
    expect(putCall?.url).toContain('api.storekit-sandbox.itunes.apple.com');
  });

  it('returns null from provider → no Apple PUT', async () => {
    const originalFetch = global.fetch;
    const fetchCalls: { url: string; method?: string }[] = [];
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = String(url);
      if (urlStr.startsWith('http://127.0.0.1') || urlStr.startsWith('http://localhost')) {
        return originalFetch(url, init);
      }
      fetchCalls.push({ url: urlStr, method: init?.method });
      return { ok: true, json: async () => ({}), text: async () => '' } as Response;
    });

    const config: OneSubServerConfig = {
      apple: {
        bundleId: 'com.example.app',
        skipJwsVerification: true,
        keyId: 'TESTKEY1',
        issuerId: 'X',
        privateKey: testEcKey,
        consumptionInfoProvider: async () => null,
      },
      database: { url: '' },
    };
    const { server } = buildAppleWebhookServer(config);

    const signedTransactionInfo = makeJws({
      bundleId: 'com.example.app',
      type: 'Consumable',
      productId: 'credits_100',
      transactionId: 'tx_skip',
      originalTransactionId: 'orig_skip',
      purchaseDate: Date.now(),
    });
    const signedPayload = makeJws({
      notificationType: 'CONSUMPTION_REQUEST',
      data: { signedTransactionInfo, signedRenewalInfo: makeJws({}) },
    });

    await server.request('POST', '/onesub/webhook/apple', { signedPayload });
    await new Promise((r) => setTimeout(r, 50));

    expect(fetchCalls.find((c) => c.method === 'PUT')).toBeUndefined();
  });

  it('skips silently when consumptionInfoProvider is not configured', async () => {
    const originalFetch = global.fetch;
    const outboundCalls: { url: string }[] = [];
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = String(url);
      if (urlStr.startsWith('http://127.0.0.1') || urlStr.startsWith('http://localhost')) {
        return originalFetch(url, init);
      }
      outboundCalls.push({ url: urlStr });
      return { ok: true, json: async () => ({}), text: async () => '' } as Response;
    });

    const config: OneSubServerConfig = {
      apple: { bundleId: 'com.example.app', skipJwsVerification: true },
      database: { url: '' },
    };
    const { server } = buildAppleWebhookServer(config);

    const signedTransactionInfo = makeJws({
      bundleId: 'com.example.app',
      type: 'Consumable',
      productId: 'credits_100',
      transactionId: 'tx_no_provider',
      originalTransactionId: 'orig_no_provider',
      purchaseDate: Date.now(),
    });
    const signedPayload = makeJws({
      notificationType: 'CONSUMPTION_REQUEST',
      data: { signedTransactionInfo, signedRenewalInfo: makeJws({}) },
    });

    const resp = await server.request('POST', '/onesub/webhook/apple', { signedPayload });
    expect(resp.status).toBe(200);
    await new Promise((r) => setTimeout(r, 50));
    expect(outboundCalls).toHaveLength(0);
  });
});
