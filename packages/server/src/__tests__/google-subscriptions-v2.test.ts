/**
 * Tests for the validateGoogleReceipt v1 → v2 migration.
 *
 * Covers:
 *   - Calls purchases.subscriptionsv2 endpoint (no productId in URL)
 *   - subscriptionState string enum → onesub SubscriptionStatus mapping
 *   - lineItems productId match (success / mismatch)
 *   - autoRenewingPlan.autoRenewEnabled → willRenew
 *   - latestOrderId → originalTransactionId
 *   - PENDING / UNSPECIFIED states rejected (return null)
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { generateKeyPairSync } from 'crypto';
import { validateGoogleReceipt } from '../providers/google.js';
import { SUBSCRIPTION_STATUS } from '@onesub/shared';
import { urlHost } from './test-utils.js';

// ── helpers ─────────────────────────────────────────────────────────────────

let testPrivateKey: string;

beforeAll(() => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  testPrivateKey = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
});

beforeEach(() => {
  vi.restoreAllMocks();
});

function makeGoogleConfig() {
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
  linkedPurchaseToken?: string;
  acknowledgementState?: string;
  lineItems?: Array<{
    productId?: string;
    expiryTime?: string;
    autoRenewingPlan?: { autoRenewEnabled?: boolean };
  }>;
}

function mockV2Fetch(responseBody: V2Response, opts?: { status?: number }) {
  const calls: { url: string }[] = [];
  vi.spyOn(global, 'fetch').mockImplementation(async (url) => {
    if (urlHost(url) === 'oauth2.googleapis.com') {
      return {
        ok: true,
        json: async () => ({ access_token: 'tok', expires_in: 3600 }),
        text: async () => '',
      } as Response;
    }
    calls.push({ url: String(url) });
    return {
      ok: (opts?.status ?? 200) < 400,
      status: opts?.status ?? 200,
      json: async () => responseBody,
      text: async () => JSON.stringify(responseBody),
    } as Response;
  });
  return calls;
}

function v2Active(productId = 'pro_monthly'): V2Response {
  return {
    startTime: '2026-01-01T00:00:00Z',
    subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
    latestOrderId: 'GPA.1234-5678-9012-12345',
    acknowledgementState: 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED',
    lineItems: [{
      productId,
      expiryTime: '2027-01-01T00:00:00Z',
      autoRenewingPlan: { autoRenewEnabled: true },
    }],
  };
}

// ── URL shape ───────────────────────────────────────────────────────────────

describe('validateGoogleReceipt — v2 endpoint', () => {
  it('calls purchases.subscriptionsv2 (token only, no productId in URL)', async () => {
    const calls = mockV2Fetch(v2Active('pro_monthly'));

    await validateGoogleReceipt('purchase_token_xyz', 'pro_monthly', makeGoogleConfig());

    const apiCall = calls.find((c) => urlHost(c.url) === 'androidpublisher.googleapis.com');
    expect(apiCall).toBeDefined();
    expect(apiCall?.url).toContain('/purchases/subscriptionsv2/tokens/purchase_token_xyz');
    expect(apiCall?.url).not.toContain('/purchases/subscriptions/');
  });
});

// ── subscriptionState mapping ───────────────────────────────────────────────

describe('validateGoogleReceipt — subscriptionState mapping', () => {
  const cases: Array<[string, string]> = [
    ['SUBSCRIPTION_STATE_ACTIVE', SUBSCRIPTION_STATUS.ACTIVE],
    ['SUBSCRIPTION_STATE_IN_GRACE_PERIOD', SUBSCRIPTION_STATUS.GRACE_PERIOD],
    ['SUBSCRIPTION_STATE_ON_HOLD', SUBSCRIPTION_STATUS.ON_HOLD],
    ['SUBSCRIPTION_STATE_PAUSED', SUBSCRIPTION_STATUS.PAUSED],
    ['SUBSCRIPTION_STATE_CANCELED', SUBSCRIPTION_STATUS.CANCELED],
    ['SUBSCRIPTION_STATE_EXPIRED', SUBSCRIPTION_STATUS.EXPIRED],
  ];

  for (const [state, expected] of cases) {
    it(`${state} → ${expected}`, async () => {
      mockV2Fetch({ ...v2Active('pro_monthly'), subscriptionState: state });
      const result = await validateGoogleReceipt('tok', 'pro_monthly', makeGoogleConfig());
      expect(result?.status).toBe(expected);
    });
  }

  it('SUBSCRIPTION_STATE_PENDING → null (entitlement not yet granted)', async () => {
    mockV2Fetch({ ...v2Active('pro_monthly'), subscriptionState: 'SUBSCRIPTION_STATE_PENDING' });
    const result = await validateGoogleReceipt('tok', 'pro_monthly', makeGoogleConfig());
    expect(result).toBeNull();
  });

  it('SUBSCRIPTION_STATE_UNSPECIFIED → null', async () => {
    mockV2Fetch({ ...v2Active('pro_monthly'), subscriptionState: 'SUBSCRIPTION_STATE_UNSPECIFIED' });
    const result = await validateGoogleReceipt('tok', 'pro_monthly', makeGoogleConfig());
    expect(result).toBeNull();
  });

  it('unknown state string → null', async () => {
    mockV2Fetch({ ...v2Active('pro_monthly'), subscriptionState: 'SOMETHING_NEW_FROM_GOOGLE' });
    const result = await validateGoogleReceipt('tok', 'pro_monthly', makeGoogleConfig());
    expect(result).toBeNull();
  });
});

// ── lineItems productId matching ────────────────────────────────────────────

describe('validateGoogleReceipt — lineItems productId match', () => {
  it('returns null when no lineItem matches the requested productId', async () => {
    mockV2Fetch(v2Active('different_product'));
    const result = await validateGoogleReceipt('tok', 'pro_monthly', makeGoogleConfig());
    expect(result).toBeNull();
  });

  it('returns null when lineItems is empty', async () => {
    mockV2Fetch({ ...v2Active(), lineItems: [] });
    const result = await validateGoogleReceipt('tok', 'pro_monthly', makeGoogleConfig());
    expect(result).toBeNull();
  });

  it('picks the matching lineItem when multiple are present (multi-product)', async () => {
    mockV2Fetch({
      ...v2Active(),
      lineItems: [
        { productId: 'addon_a', expiryTime: '2099-01-01T00:00:00Z', autoRenewingPlan: { autoRenewEnabled: true } },
        { productId: 'pro_monthly', expiryTime: '2027-06-01T00:00:00Z', autoRenewingPlan: { autoRenewEnabled: true } },
        { productId: 'addon_b', expiryTime: '2099-12-31T00:00:00Z', autoRenewingPlan: { autoRenewEnabled: false } },
      ],
    });
    const result = await validateGoogleReceipt('tok', 'pro_monthly', makeGoogleConfig());
    expect(result).not.toBeNull();
    expect(result?.productId).toBe('pro_monthly');
    expect(result?.expiresAt).toBe('2027-06-01T00:00:00Z');
    expect(result?.willRenew).toBe(true);
  });
});

// ── field mapping ───────────────────────────────────────────────────────────

describe('validateGoogleReceipt — field mapping', () => {
  it('uses latestOrderId as originalTransactionId', async () => {
    mockV2Fetch({ ...v2Active('pro_monthly'), latestOrderId: 'GPA.canonical-order-id' });
    const result = await validateGoogleReceipt('tok', 'pro_monthly', makeGoogleConfig());
    expect(result?.originalTransactionId).toBe('GPA.canonical-order-id');
  });

  it('falls back to truncated purchaseToken when latestOrderId is absent', async () => {
    const noOrder = v2Active('pro_monthly');
    delete noOrder.latestOrderId;
    mockV2Fetch(noOrder);
    const result = await validateGoogleReceipt('a-very-very-long-token-' + 'x'.repeat(100), 'pro_monthly', makeGoogleConfig());
    expect(result?.originalTransactionId).toBeDefined();
    expect(result?.originalTransactionId.length).toBeLessThanOrEqual(64);
  });

  it('autoRenewEnabled false → willRenew false', async () => {
    mockV2Fetch({
      ...v2Active(),
      lineItems: [{
        productId: 'pro_monthly',
        expiryTime: '2027-01-01T00:00:00Z',
        autoRenewingPlan: { autoRenewEnabled: false },
      }],
    });
    const result = await validateGoogleReceipt('tok', 'pro_monthly', makeGoogleConfig());
    expect(result?.willRenew).toBe(false);
  });

  it('missing autoRenewingPlan → willRenew false', async () => {
    mockV2Fetch({
      ...v2Active(),
      lineItems: [{ productId: 'pro_monthly', expiryTime: '2027-01-01T00:00:00Z' }],
    });
    const result = await validateGoogleReceipt('tok', 'pro_monthly', makeGoogleConfig());
    expect(result?.willRenew).toBe(false);
  });

  it('uses lineItem.expiryTime for expiresAt and startTime for purchasedAt', async () => {
    mockV2Fetch({
      startTime: '2025-12-01T10:00:00Z',
      subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
      latestOrderId: 'GPA.x',
      lineItems: [{
        productId: 'pro_monthly',
        expiryTime: '2026-12-01T10:00:00Z',
        autoRenewingPlan: { autoRenewEnabled: true },
      }],
    });
    const result = await validateGoogleReceipt('tok', 'pro_monthly', makeGoogleConfig());
    expect(result?.purchasedAt).toBe('2025-12-01T10:00:00Z');
    expect(result?.expiresAt).toBe('2026-12-01T10:00:00Z');
  });
});

// ── error paths ─────────────────────────────────────────────────────────────

describe('validateGoogleReceipt — error paths', () => {
  it('returns null on Play API error response', async () => {
    mockV2Fetch({}, { status: 410 });
    const result = await validateGoogleReceipt('tok', 'pro_monthly', makeGoogleConfig());
    expect(result).toBeNull();
  });

  it('returns null when serviceAccountKey is missing', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch');
    const result = await validateGoogleReceipt('tok', 'pro_monthly', { packageName: 'com.example.app' });
    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
