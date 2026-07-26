import { describe, it, expect } from 'vitest';
import request from 'supertest';
import express from 'express';
import type { OneSubServerConfig } from '@onesub/shared';
import { ONESUB_ERROR_CODE, SUBSCRIPTION_STATUS, MOCK_RECEIPT_PREFIX } from '@onesub/shared';
import { createOneSubMiddleware } from '../index.js';
import { InMemorySubscriptionStore, InMemoryPurchaseStore } from '../store.js';
import {
  classifyMockReceipt,
  mockValidateAppleSubscription,
  mockValidateAppleProduct,
  mockValidateGoogleSubscription,
  mockValidateGoogleProduct,
} from '../providers/mock.js';

const EMPTY_APP_ACCOUNT_TOKEN = '00000000-0000-0000-0000-000000000000';

/** Full onesub server in mockMode on both platforms — shared by the HTTP describes. */
function mockApp() {
  const config: OneSubServerConfig = {
    database: { url: '' },
    apple: { bundleId: 'com.test.mock', mockMode: true },
    google: { packageName: 'com.test.mock', mockMode: true },
  };
  const app = express();
  app.use(createOneSubMiddleware({
    ...config,
    store: new InMemorySubscriptionStore(),
    purchaseStore: new InMemoryPurchaseStore(),
  }));
  return app;
}

// ---------------------------------------------------------------------------
// Pure classifier
// ---------------------------------------------------------------------------
describe('classifyMockReceipt', () => {
  const cases: Array<[string, string]> = [
    [`${MOCK_RECEIPT_PREFIX.REVOKED}_tx1`, 'revoked'],
    [`${MOCK_RECEIPT_PREFIX.EXPIRED}_tx1`, 'expired'],
    [`${MOCK_RECEIPT_PREFIX.INVALID}_tx1`, 'invalid'],
    [`${MOCK_RECEIPT_PREFIX.BAD_SIG}_tx1`, 'invalid'],
    [`${MOCK_RECEIPT_PREFIX.NETWORK_ERROR}_tx1`, 'network-error'],
    [`${MOCK_RECEIPT_PREFIX.SANDBOX}_tx1`, 'sandbox'],
    ['MOCK_anything_else', 'valid'],
    ['not_even_a_mock_prefix', 'valid'],
  ];
  for (const [receipt, expected] of cases) {
    it(`classifies ${receipt} as ${expected}`, () => {
      expect(classifyMockReceipt(receipt).kind).toBe(expected);
    });
  }
});

// ---------------------------------------------------------------------------
// Pure mock provider functions
// ---------------------------------------------------------------------------
describe('mockValidateAppleSubscription', () => {
  it('returns ACTIVE subscription for valid receipt', () => {
    const sub = mockValidateAppleSubscription('MOCK_VALID_sub_1');
    expect(sub).toMatchObject({
      platform: 'apple',
      status: SUBSCRIPTION_STATUS.ACTIVE,
      willRenew: true,
    });
    expect(sub?.originalTransactionId).toContain('mock_apple_orig_');
  });

  it('returns null for MOCK_REVOKED', () => {
    expect(mockValidateAppleSubscription('MOCK_REVOKED_x')).toBeNull();
  });

  it('throws for MOCK_NETWORK_ERROR', () => {
    expect(() => mockValidateAppleSubscription('MOCK_NETWORK_ERROR_x')).toThrow(/network error/);
  });

  it('produces deterministic transactionIds', () => {
    const a = mockValidateAppleSubscription('MOCK_VALID_same');
    const b = mockValidateAppleSubscription('MOCK_VALID_same');
    expect(a?.originalTransactionId).toBe(b?.originalTransactionId);
  });

  it('sandbox receipts get shorter expiry (~1h)', () => {
    const sub = mockValidateAppleSubscription('MOCK_SANDBOX_x');
    const expiry = Date.parse(sub!.expiresAt);
    const ageMs = expiry - Date.now();
    expect(ageMs).toBeGreaterThan(30 * 60 * 1000);       // > 30 min
    expect(ageMs).toBeLessThan(2 * 60 * 60 * 1000);      // < 2 h
  });
});

describe('mockValidateAppleProduct', () => {
  it('returns product result with productId for valid receipt', () => {
    const result = mockValidateAppleProduct('MOCK_VALID_x', 'premium');
    expect(result).toMatchObject({ productId: 'premium' });
    expect(result?.transactionId).toContain('mock_apple_premium_');
  });

  it('returns null for MOCK_EXPIRED', () => {
    expect(mockValidateAppleProduct('MOCK_EXPIRED_x', 'premium')).toBeNull();
  });
});

describe('mockValidateGoogleSubscription', () => {
  it('returns ACTIVE subscription for valid token', () => {
    const sub = mockValidateGoogleSubscription('MOCK_VALID_x', 'pro_monthly');
    expect(sub).toMatchObject({
      platform: 'google',
      productId: 'pro_monthly',
      status: SUBSCRIPTION_STATUS.ACTIVE,
    });
  });

  it('throws for MOCK_NETWORK_ERROR', () => {
    expect(() => mockValidateGoogleSubscription('MOCK_NETWORK_ERROR_x', 'pro'))
      .toThrow(/network error/);
  });
});

describe('mockValidateGoogleProduct', () => {
  it('returns product result for valid token', () => {
    const result = mockValidateGoogleProduct('MOCK_VALID_x', 'credits_100');
    expect(result?.transactionId).toContain('mock_google_credits_100_');
  });

  it('returns null for MOCK_INVALID', () => {
    expect(mockValidateGoogleProduct('MOCK_INVALID_x', 'credits_100')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// HTTP integration — full onesub server with mockMode on both platforms.
// This is the key demo: a server standing up without real Apple / Google
// credentials, yet the full purchase flow completes end-to-end.
// ---------------------------------------------------------------------------
describe('full server in mockMode', () => {
  it('validates an Apple subscription without any real credentials', async () => {
    const app = mockApp();
    const res = await request(app).post('/onesub/validate').send({
      platform: 'apple',
      receipt: 'MOCK_VALID_apple_sub_1',
      userId: 'user_1',
      productId: 'pro_monthly',
    });
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(true);
    expect(res.body.subscription.status).toBe('active');
  });

  it('validates a Google non-consumable purchase without credentials', async () => {
    const app = mockApp();
    const res = await request(app).post('/onesub/purchase/validate').send({
      platform: 'google',
      receipt: 'MOCK_VALID_google_product_1',
      userId: 'user_1',
      productId: 'premium',
      type: 'non_consumable',
    });
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(true);
    expect(res.body.action).toBe('new');
  });

  it('MOCK_REVOKED returns RECEIPT_VALIDATION_FAILED via normal error path', async () => {
    const app = mockApp();
    const res = await request(app).post('/onesub/purchase/validate').send({
      platform: 'apple',
      receipt: 'MOCK_REVOKED_x',
      userId: 'user_1',
      productId: 'premium',
      type: 'non_consumable',
    });
    expect(res.status).toBe(422);
    expect(res.body.errorCode).toBe(ONESUB_ERROR_CODE.RECEIPT_VALIDATION_FAILED);
  });

  it('throws when NODE_ENV=production + mockMode is set (fraud guard)', () => {
    const original = process.env['NODE_ENV'];
    process.env['NODE_ENV'] = 'production';
    try {
      expect(() => createOneSubMiddleware({
        database: { url: '' },
        apple: { bundleId: 'com.test', mockMode: true },
        store: new InMemorySubscriptionStore(),
        purchaseStore: new InMemoryPurchaseStore(),
      })).toThrow(/mockMode cannot be enabled when NODE_ENV=production/);
    } finally {
      if (original === undefined) delete process.env['NODE_ENV'];
      else process.env['NODE_ENV'] = original;
    }
  });

  it('replaying the same receipt returns action:restored (server idempotency)', async () => {
    const app = mockApp();
    const body = {
      platform: 'apple',
      receipt: 'MOCK_VALID_replay_test',
      userId: 'user_1',
      productId: 'premium',
      type: 'non_consumable',
    };
    const first = await request(app).post('/onesub/purchase/validate').send(body);
    expect(first.body.action).toBe('new');

    // Wipe the user's record so hasPurchased() is false (NON_CONSUMABLE_ALREADY_OWNED
    // would short-circuit otherwise). Use a different userId to hit the same
    // transactionId path.
    const second = await request(app).post('/onesub/purchase/validate').send({ ...body, userId: 'user_2' });
    // non-consumable with same transactionId but different userId → auto-reassigned (0.6.1+)
    // (backward-compat: no appAccountToken on the receipt → binding guard skipped)
    expect(second.body.valid).toBe(true);
    expect(second.body.action).toBe('restored');
  });

  it('account-binding: receipt appAccountToken matching userId is accepted', async () => {
    const app = mockApp();
    const res = await request(app).post('/onesub/purchase/validate').send({
      platform: 'apple',
      receipt: 'MOCK_VALID_bind_ok#token=acct-uuid-1',
      userId: 'acct-uuid-1',
      productId: 'premium',
      type: 'non_consumable',
    });
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(true);
    expect(res.body.action).toBe('new');
  });

  it('account-binding: receipt appAccountToken not matching userId is rejected (payment-bypass guard)', async () => {
    const app = mockApp();
    // A valid receipt bound to acct-uuid-1 cannot be attributed to a different
    // userId — blocks a leaked/valid JWS being planted on an attacker deviceId.
    const res = await request(app).post('/onesub/purchase/validate').send({
      platform: 'apple',
      receipt: 'MOCK_VALID_bind_mismatch#token=acct-uuid-1',
      userId: 'attacker-uuid-2',
      productId: 'premium',
      type: 'non_consumable',
    });
    expect(res.status).toBe(409);
    expect(res.body.errorCode).toBe(ONESUB_ERROR_CODE.TRANSACTION_BELONGS_TO_OTHER_USER);
  });

  it('account-binding: Apple Guid.Empty is unbound, while transaction ownership still rejects a consumable replay', async () => {
    const app = mockApp();
    const body = {
      platform: 'apple',
      receipt: `MOCK_VALID_empty_guid#token=${EMPTY_APP_ACCOUNT_TOKEN}`,
      userId: 'firebase-user-a',
      productId: 'credits_100',
      type: 'consumable',
    };

    const first = await request(app).post('/onesub/purchase/validate').send(body);
    expect(first.status).toBe(200);
    expect(first.body.action).toBe('new');

    const replay = await request(app).post('/onesub/purchase/validate').send({
      ...body,
      userId: 'firebase-user-b',
    });
    expect(replay.status).toBe(409);
    expect(replay.body.errorCode).toBe(ONESUB_ERROR_CODE.TRANSACTION_BELONGS_TO_OTHER_USER);
  });

  it('account-binding: Google obfuscatedExternalAccountId matching userId is accepted', async () => {
    const app = mockApp();
    const res = await request(app).post('/onesub/purchase/validate').send({
      platform: 'google',
      receipt: 'MOCK_VALID_gbind_ok#token=acct-uuid-g1',
      userId: 'acct-uuid-g1',
      productId: 'premium',
      type: 'non_consumable',
    });
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(true);
    expect(res.body.action).toBe('new');
  });

  it('account-binding: Google obfuscatedExternalAccountId mismatch is rejected (payment-bypass guard)', async () => {
    const app = mockApp();
    // A leaked Google purchaseToken bound to acct-uuid-g1 cannot be attributed
    // to a different userId — same guard as Apple, symmetric coverage.
    const res = await request(app).post('/onesub/purchase/validate').send({
      platform: 'google',
      receipt: 'MOCK_VALID_gbind_mismatch#token=acct-uuid-g1',
      userId: 'attacker-uuid-g2',
      productId: 'premium',
      type: 'non_consumable',
    });
    expect(res.status).toBe(409);
    expect(res.body.errorCode).toBe(ONESUB_ERROR_CODE.TRANSACTION_BELONGS_TO_OTHER_USER);
  });

  it('account-binding: Google keeps the all-zero string as a real bound account id', async () => {
    const app = mockApp();
    const res = await request(app).post('/onesub/purchase/validate').send({
      platform: 'google',
      receipt: `MOCK_VALID_google_zero#token=${EMPTY_APP_ACCOUNT_TOKEN}`,
      userId: 'firebase-user',
      productId: 'premium',
      type: 'non_consumable',
    });

    expect(res.status).toBe(409);
    expect(res.body.errorCode).toBe(ONESUB_ERROR_CODE.TRANSACTION_BELONGS_TO_OTHER_USER);
  });
});

// ---------------------------------------------------------------------------
// Subscription route account-binding (mirrors the one-time purchase guard)
// ---------------------------------------------------------------------------
describe('POST /onesub/validate — subscription account-binding', () => {
  it('treats Apple Guid.Empty as an unbound subscription token', async () => {
    const app = mockApp();
    const res = await request(app).post('/onesub/validate').send({
      platform: 'apple',
      receipt: `MOCK_VALID_sub_empty_guid#token=${EMPTY_APP_ACCOUNT_TOKEN}`,
      userId: 'firebase-user',
      productId: 'premium_monthly',
    });

    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(true);
    expect(res.body.subscription.userId).toBe('firebase-user');
  });

  it('receipt bound to a matching userId is accepted and stored', async () => {
    const app = mockApp();
    const res = await request(app).post('/onesub/validate').send({
      platform: 'apple',
      receipt: 'MOCK_VALID_sub_bind_ok#token=acct-sub-1',
      userId: 'acct-sub-1',
      productId: 'premium_monthly',
    });
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(true);
    // boundAccountId is transient — must not leak into the stored/returned record
    expect(res.body.subscription.boundAccountId).toBeUndefined();
  });

  it('receipt bound to a different account is rejected with 409 (payment-bypass guard)', async () => {
    const app = mockApp();
    const res = await request(app).post('/onesub/validate').send({
      platform: 'apple',
      receipt: 'MOCK_VALID_sub_bind_no#token=acct-sub-1',
      userId: 'attacker-uuid',
      productId: 'premium_monthly',
    });
    expect(res.status).toBe(409);
    expect(res.body.errorCode).toBe(ONESUB_ERROR_CODE.TRANSACTION_BELONGS_TO_OTHER_USER);
  });

  it('Google subscription binding mismatch is rejected symmetrically', async () => {
    const app = mockApp();
    const res = await request(app).post('/onesub/validate').send({
      platform: 'google',
      receipt: 'MOCK_VALID_gsub_bind#token=acct-gsub-1',
      userId: 'attacker-uuid-g',
      productId: 'premium_monthly',
    });
    expect(res.status).toBe(409);
    expect(res.body.errorCode).toBe(ONESUB_ERROR_CODE.TRANSACTION_BELONGS_TO_OTHER_USER);
  });

  it('Apple binding is case-insensitive (appAccountToken is a lowercase-normalized UUID)', async () => {
    const app = mockApp();
    const res = await request(app).post('/onesub/validate').send({
      platform: 'apple',
      receipt: 'MOCK_VALID_sub_case#token=acct-uuid-ab12',
      userId: 'ACCT-UUID-AB12',
      productId: 'premium_monthly',
    });
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(true);
  });

  it('Google binding is case-SENSITIVE — a case-flipped userId must not pass the guard', async () => {
    const app = mockApp();
    const res = await request(app).post('/onesub/validate').send({
      platform: 'google',
      receipt: 'MOCK_VALID_gsub_case#token=a1B2c3',
      userId: 'A1b2C3',
      productId: 'premium_monthly',
    });
    expect(res.status).toBe(409);
    expect(res.body.errorCode).toBe(ONESUB_ERROR_CODE.TRANSACTION_BELONGS_TO_OTHER_USER);
  });

  it('unbound receipt keeps legacy rebind behavior (backward compatibility)', async () => {
    const app = mockApp();
    const receipt = 'MOCK_VALID_sub_unbound';
    const first = await request(app).post('/onesub/validate').send({
      platform: 'apple', receipt, userId: 'user_a', productId: 'premium_monthly',
    });
    expect(first.status).toBe(200);
    // No token baked in → guard skipped → rebinding to a new userId still works
    const second = await request(app).post('/onesub/validate').send({
      platform: 'apple', receipt, userId: 'user_b', productId: 'premium_monthly',
    });
    expect(second.status).toBe(200);
    expect(second.body.subscription.userId).toBe('user_b');
  });
});
