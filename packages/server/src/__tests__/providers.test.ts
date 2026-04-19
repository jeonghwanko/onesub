/**
 * Unit tests for Apple and Google product receipt validators.
 * Covers: validateAppleConsumableReceipt, validateGoogleProductReceipt
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { generateKeyPairSync } from 'crypto';
import { validateAppleConsumableReceipt } from '../providers/apple.js';
import { validateGoogleProductReceipt } from '../providers/google.js';

// ── Apple helpers ──────────────────────────────────────────────────────────

/**
 * Build a minimal JWS token whose payload is the given object.
 * With skipJwsVerification=true, decodeJwt() only base64url-decodes the payload.
 */
function makeJws(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'ES256' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.fakesig`;
}

const APPLE_CONFIG = { bundleId: 'com.example.app', skipJwsVerification: true as const };

function validApplePayload(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    bundleId: 'com.example.app',
    type: 'Consumable',
    productId: 'credits_100',
    transactionId: 'txn_apple_001',
    originalTransactionId: 'orig_apple_001',
    purchaseDate: Date.now(),
    ...overrides,
  };
}

// ── Google helpers ──────────────────────────────────────────────────────────

let testPrivateKey: string;

beforeAll(() => {
  // Generate a real RSA key pair once — needed for the JWT assertion in getAccessToken().
  // 1024-bit is sufficient for tests (not production).
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 1024 });
  testPrivateKey = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
});

beforeEach(() => {
  vi.restoreAllMocks();
});

/**
 * Create a fresh Google config with a unique client_email per call.
 * The module-level token cache in google.ts is keyed by the full JSON string,
 * so varying the email ensures each test starts with a cold cache.
 */
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

type MockProductPurchase = {
  purchaseState?: number;
  consumptionState?: number;
  purchaseTimeMillis?: string;
  orderId?: string;
};

/**
 * Mock global fetch with URL-based routing:
 * - oauth2.googleapis.com → returns a fake access token
 * - androidpublisher.googleapis.com → returns the given product purchase object
 */
function mockGoogleFetch(productPurchase: MockProductPurchase) {
  vi.spyOn(global, 'fetch').mockImplementation(async (url) => {
    const urlStr = String(url);
    if (urlStr.includes('oauth2.googleapis.com')) {
      return {
        ok: true,
        json: async () => ({ access_token: 'test_access_token', expires_in: 3600 }),
        text: async () => '',
      } as Response;
    }
    if (urlStr.includes('androidpublisher.googleapis.com')) {
      return {
        ok: true,
        json: async () => productPurchase,
        text: async () => JSON.stringify(productPurchase),
      } as Response;
    }
    throw new Error(`[test] Unexpected fetch URL: ${urlStr}`);
  });
}

// ============================================================================
// validateAppleConsumableReceipt
// ============================================================================

describe('validateAppleConsumableReceipt', () => {
  it('returns null when bundleId is missing in receipt', async () => {
    const jws = makeJws(validApplePayload({ bundleId: undefined }));
    expect(await validateAppleConsumableReceipt(jws, APPLE_CONFIG)).toBeNull();
  });

  it('returns null when bundleId mismatches config', async () => {
    const jws = makeJws(validApplePayload({ bundleId: 'com.attacker.app' }));
    expect(await validateAppleConsumableReceipt(jws, APPLE_CONFIG)).toBeNull();
  });

  it('returns null for Auto-Renewable Subscription type (not a consumable)', async () => {
    const jws = makeJws(validApplePayload({ type: 'Auto-Renewable Subscription' }));
    expect(await validateAppleConsumableReceipt(jws, APPLE_CONFIG)).toBeNull();
  });

  it('returns null for NonRenewingSubscription type', async () => {
    const jws = makeJws(validApplePayload({ type: 'Non-Renewing Subscription' }));
    expect(await validateAppleConsumableReceipt(jws, APPLE_CONFIG)).toBeNull();
  });

  it('returns null when the purchase is revoked (refunded)', async () => {
    const jws = makeJws(validApplePayload({ revocationDate: Date.now() - 1000 }));
    expect(await validateAppleConsumableReceipt(jws, APPLE_CONFIG)).toBeNull();
  });

  it('returns null when receipt is older than 72 hours', async () => {
    const jws = makeJws(validApplePayload({ purchaseDate: Date.now() - 73 * 60 * 60 * 1000 }));
    expect(await validateAppleConsumableReceipt(jws, APPLE_CONFIG)).toBeNull();
  });

  it('accepts a receipt that is exactly 71 hours old', async () => {
    const jws = makeJws(validApplePayload({ purchaseDate: Date.now() - 71 * 60 * 60 * 1000 }));
    expect(await validateAppleConsumableReceipt(jws, APPLE_CONFIG)).not.toBeNull();
  });

  it('returns null when expectedProductId mismatches receipt', async () => {
    const jws = makeJws(validApplePayload({ productId: 'credits_200' }));
    expect(await validateAppleConsumableReceipt(jws, APPLE_CONFIG, 'credits_100')).toBeNull();
  });

  it('validates productId when expectedProductId matches', async () => {
    const jws = makeJws(validApplePayload({ productId: 'credits_100' }));
    expect(await validateAppleConsumableReceipt(jws, APPLE_CONFIG, 'credits_100')).not.toBeNull();
  });

  it('returns null when JWS is malformed', async () => {
    expect(await validateAppleConsumableReceipt('not.a.valid.jws.format', APPLE_CONFIG)).toBeNull();
  });

  it('returns valid result with correct fields for a Consumable purchase', async () => {
    const now = Date.now();
    const jws = makeJws(validApplePayload({
      transactionId: 'txn_abc',
      originalTransactionId: 'orig_abc',
      purchaseDate: now,
    }));
    const result = await validateAppleConsumableReceipt(jws, APPLE_CONFIG);
    expect(result).not.toBeNull();
    expect(result?.transactionId).toBe('txn_abc');
    expect(result?.productId).toBe('credits_100');
    expect(result?.purchasedAt).toBe(new Date(now).toISOString());
  });

  it('uses transactionId (not originalTransactionId) for consumables', async () => {
    const jws = makeJws(validApplePayload({
      transactionId: 'per_tx_id',
      originalTransactionId: 'shared_orig_id',
    }));
    const result = await validateAppleConsumableReceipt(jws, APPLE_CONFIG);
    // per-transaction ID must be used — originalTransactionId is shared across re-purchases
    expect(result?.transactionId).toBe('per_tx_id');
    expect(result?.transactionId).not.toBe('shared_orig_id');
  });

  it('falls back to originalTransactionId when transactionId is absent', async () => {
    const jws = makeJws(validApplePayload({
      transactionId: undefined,
      originalTransactionId: 'orig_only',
    }));
    const result = await validateAppleConsumableReceipt(jws, APPLE_CONFIG);
    expect(result?.transactionId).toBe('orig_only');
  });

  it('accepts Non-Consumable type', async () => {
    const jws = makeJws(validApplePayload({ type: 'Non-Consumable', productId: 'premium_unlock' }));
    const result = await validateAppleConsumableReceipt(jws, APPLE_CONFIG);
    expect(result).not.toBeNull();
  });
});

// ============================================================================
// validateGoogleProductReceipt
// ============================================================================

describe('validateGoogleProductReceipt', () => {
  it('returns null when serviceAccountKey is not provided', async () => {
    const result = await validateGoogleProductReceipt(
      'some_token',
      'credits_100',
      { packageName: 'com.example.app' },
    );
    expect(result).toBeNull();
  });

  it('returns null when purchaseState is 1 (canceled)', async () => {
    mockGoogleFetch({ purchaseState: 1, orderId: 'GPA.canceled' });
    const result = await validateGoogleProductReceipt(
      'token_canceled',
      'credits_100',
      makeGoogleConfig(),
    );
    expect(result).toBeNull();
  });

  it('returns null when purchaseState is 2 (pending)', async () => {
    mockGoogleFetch({ purchaseState: 2, orderId: 'GPA.pending' });
    const result = await validateGoogleProductReceipt(
      'token_pending',
      'credits_100',
      makeGoogleConfig(),
    );
    expect(result).toBeNull();
  });

  it('returns null for consumable when consumptionState is 1 (already consumed)', async () => {
    mockGoogleFetch({
      purchaseState: 0,
      consumptionState: 1,
      purchaseTimeMillis: String(Date.now()),
      orderId: 'GPA.already_consumed',
    });
    const result = await validateGoogleProductReceipt(
      'token_consumed',
      'credits_100',
      makeGoogleConfig(),
      'consumable',
    );
    expect(result).toBeNull();
  });

  it('does NOT block non-consumable when consumptionState is 1', async () => {
    // Non-consumables may have consumptionState=1 after acknowledgement — this is normal
    mockGoogleFetch({
      purchaseState: 0,
      consumptionState: 1,
      purchaseTimeMillis: String(Date.now()),
      orderId: 'GPA.nc_acknowledged',
    });
    const result = await validateGoogleProductReceipt(
      'token_nc',
      'premium_unlock',
      makeGoogleConfig(),
      'non_consumable',
    );
    expect(result).not.toBeNull();
    expect(result?.transactionId).toBe('GPA.nc_acknowledged');
  });

  it('returns null when receipt is older than 72 hours', async () => {
    const oldMs = String(Date.now() - 73 * 60 * 60 * 1000);
    mockGoogleFetch({
      purchaseState: 0,
      purchaseTimeMillis: oldMs,
      orderId: 'GPA.old',
    });
    const result = await validateGoogleProductReceipt(
      'token_old',
      'credits_100',
      makeGoogleConfig(),
    );
    expect(result).toBeNull();
  });

  it('accepts a receipt that is exactly 71 hours old', async () => {
    const recentMs = String(Date.now() - 71 * 60 * 60 * 1000);
    mockGoogleFetch({
      purchaseState: 0,
      consumptionState: 0,
      purchaseTimeMillis: recentMs,
      orderId: 'GPA.recent',
    });
    const result = await validateGoogleProductReceipt(
      'token_recent',
      'credits_100',
      makeGoogleConfig(),
      'consumable',
    );
    expect(result).not.toBeNull();
  });

  it('returns null when orderId is missing', async () => {
    mockGoogleFetch({
      purchaseState: 0,
      purchaseTimeMillis: String(Date.now()),
      // orderId absent
    });
    const result = await validateGoogleProductReceipt(
      'token_no_order',
      'credits_100',
      makeGoogleConfig(),
    );
    expect(result).toBeNull();
  });

  it('returns valid result with orderId as transactionId on success', async () => {
    const now = Date.now();
    mockGoogleFetch({
      purchaseState: 0,
      consumptionState: 0,
      purchaseTimeMillis: String(now),
      orderId: 'GPA.valid_order_123',
    });
    const result = await validateGoogleProductReceipt(
      'token_valid',
      'credits_100',
      makeGoogleConfig(),
      'consumable',
    );
    expect(result).not.toBeNull();
    expect(result?.transactionId).toBe('GPA.valid_order_123');
    expect(result?.purchasedAt).toBe(new Date(now).toISOString());
  });

  it('returns null when Play API returns an error response', async () => {
    vi.spyOn(global, 'fetch').mockImplementation(async (url) => {
      const urlStr = String(url);
      if (urlStr.includes('oauth2.googleapis.com')) {
        return {
          ok: true,
          json: async () => ({ access_token: 'tok', expires_in: 3600 }),
          text: async () => '',
        } as Response;
      }
      return { ok: false, text: async () => 'Not Found', json: async () => ({}) } as Response;
    });

    const result = await validateGoogleProductReceipt(
      'token_bad',
      'credits_100',
      makeGoogleConfig(),
    );
    expect(result).toBeNull();
  });
});
