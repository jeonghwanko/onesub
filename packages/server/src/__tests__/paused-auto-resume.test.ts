/**
 * Tests for SubscriptionInfo.autoResumeTime — Google paused subscriptions
 * surface the auto-resume timestamp from v2 pausedStateContext, so host apps
 * can render "재개 예정: YYYY-MM-DD" UX.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import express from 'express';
import { generateKeyPairSync } from 'crypto';
import type { OneSubServerConfig, SubscriptionInfo } from '@onesub/shared';
import { SUBSCRIPTION_STATUS } from '@onesub/shared';
import { validateGoogleReceipt } from '../providers/google.js';
import { createStatusRouter } from '../routes/status.js';
import { InMemorySubscriptionStore } from '../store.js';
import { isLocalhostUrl, urlHost } from './test-utils.js';

let testPrivateKey: string;

beforeAll(() => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  testPrivateKey = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
});

beforeEach(() => {
  vi.restoreAllMocks();
});

function googleConfig(): NonNullable<OneSubServerConfig['google']> {
  return {
    packageName: 'com.example.app',
    serviceAccountKey: JSON.stringify({
      client_email: `test-${Math.random()}@test.iam.gserviceaccount.com`,
      private_key: testPrivateKey,
      token_uri: 'https://oauth2.googleapis.com/token',
    }),
  };
}

interface V2Response {
  startTime?: string;
  subscriptionState?: string;
  latestOrderId?: string;
  pausedStateContext?: { autoResumeTime?: string };
  lineItems?: Array<{
    productId?: string;
    expiryTime?: string;
    autoRenewingPlan?: { autoRenewEnabled?: boolean };
  }>;
}

function v2Paused(opts: { autoResumeTime?: string; productId?: string }): V2Response {
  return {
    startTime: '2026-01-01T00:00:00Z',
    subscriptionState: 'SUBSCRIPTION_STATE_PAUSED',
    latestOrderId: 'GPA.paused_order',
    pausedStateContext: opts.autoResumeTime ? { autoResumeTime: opts.autoResumeTime } : undefined,
    lineItems: [{
      productId: opts.productId ?? 'pro_monthly',
      expiryTime: '2027-01-01T00:00:00Z',
      autoRenewingPlan: { autoRenewEnabled: true },
    }],
  };
}

function v2Active(productId = 'pro_monthly'): V2Response {
  return {
    startTime: '2026-01-01T00:00:00Z',
    subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
    latestOrderId: 'GPA.active_order',
    lineItems: [{
      productId,
      expiryTime: '2027-01-01T00:00:00Z',
      autoRenewingPlan: { autoRenewEnabled: true },
    }],
  };
}

function mockV2Fetch(responseBody: V2Response) {
  const originalFetch = global.fetch;
  vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
    if (isLocalhostUrl(url)) return originalFetch(url, init);
    const host = urlHost(url);
    if (host === 'oauth2.googleapis.com') {
      return {
        ok: true,
        json: async () => ({ access_token: 'tok', expires_in: 3600 }),
        text: async () => '',
      } as Response;
    }
    if (host === 'androidpublisher.googleapis.com') {
      return {
        ok: true,
        json: async () => responseBody,
        text: async () => JSON.stringify(responseBody),
      } as Response;
    }
    throw new Error(`[test] Unexpected URL: ${String(url)}`);
  });
}

// ── validateGoogleReceipt surfaces autoResumeTime ───────────────────────────

describe('validateGoogleReceipt — autoResumeTime passthrough', () => {
  it('surfaces autoResumeTime when subscription is paused', async () => {
    mockV2Fetch(v2Paused({ autoResumeTime: '2026-08-15T00:00:00Z' }));

    const result = await validateGoogleReceipt('tok_paused', 'pro_monthly', googleConfig());

    expect(result?.status).toBe(SUBSCRIPTION_STATUS.PAUSED);
    expect(result?.autoResumeTime).toBe('2026-08-15T00:00:00Z');
  });

  it('autoResumeTime is undefined when paused but Google omits the timestamp', async () => {
    // Google sometimes returns SUBSCRIPTION_STATE_PAUSED without
    // pausedStateContext (rare, but the API allows it).
    mockV2Fetch(v2Paused({}));

    const result = await validateGoogleReceipt('tok_paused_no_ctx', 'pro_monthly', googleConfig());

    expect(result?.status).toBe(SUBSCRIPTION_STATUS.PAUSED);
    expect(result?.autoResumeTime).toBeUndefined();
  });

  it('autoResumeTime is undefined for active subscription (no pausedStateContext)', async () => {
    mockV2Fetch(v2Active('pro_monthly'));

    const result = await validateGoogleReceipt('tok_active', 'pro_monthly', googleConfig());

    expect(result?.status).toBe(SUBSCRIPTION_STATUS.ACTIVE);
    expect(result?.autoResumeTime).toBeUndefined();
  });

  it('autoResumeTime is undefined even if pausedStateContext appears on a non-paused state (defensive)', async () => {
    // Google shouldn't send pausedStateContext for non-paused states, but if
    // they ever do, we should not surface it as if the user were paused.
    mockV2Fetch({
      ...v2Active('pro_monthly'),
      pausedStateContext: { autoResumeTime: '2099-01-01T00:00:00Z' },
    });

    const result = await validateGoogleReceipt('tok_defensive', 'pro_monthly', googleConfig());

    expect(result?.status).toBe(SUBSCRIPTION_STATUS.ACTIVE);
    expect(result?.autoResumeTime).toBeUndefined();
  });
});

// ── status route surfaces autoResumeTime in subscription payload ────────────

interface TestServer {
  request: (path: string) => Promise<{ status: number; body: unknown }>;
}

function spinUpStatus(): { store: InMemorySubscriptionStore; server: TestServer } {
  const store = new InMemorySubscriptionStore();
  const app = express();
  app.use(express.json());
  app.use(createStatusRouter(store));
  return {
    store,
    server: {
      async request(path) {
        const httpServer = app.listen(0);
        const address = httpServer.address();
        const port = typeof address === 'object' && address ? address.port : 0;
        try {
          const resp = await fetch(`http://127.0.0.1:${port}${path}`);
          const body = await resp.json();
          return { status: resp.status, body };
        } finally {
          await new Promise<void>((resolve) => httpServer.close(() => resolve()));
        }
      },
    },
  };
}

const sampleSub = (overrides?: Partial<SubscriptionInfo>): SubscriptionInfo => ({
  userId: 'u_pause',
  productId: 'pro_monthly',
  platform: 'google',
  status: 'paused',
  expiresAt: '2099-01-01T00:00:00.000Z',
  originalTransactionId: 'tok_p',
  purchasedAt: '2026-01-01T00:00:00.000Z',
  willRenew: true,
  ...overrides,
});

describe('status route — autoResumeTime in subscription payload', () => {
  it('returns the saved autoResumeTime so the host can show "재개 예정" UX', async () => {
    const { store, server } = spinUpStatus();
    await store.save(sampleSub({
      userId: 'u_with_resume',
      autoResumeTime: '2026-09-01T00:00:00.000Z',
    }));

    const resp = await server.request('/onesub/status?userId=u_with_resume');
    const body = resp.body as { active: boolean; subscription: SubscriptionInfo | null };

    expect(body.active).toBe(false);  // paused stays revoked
    expect(body.subscription?.autoResumeTime).toBe('2026-09-01T00:00:00.000Z');
  });
});
