/**
 * SDK API helpers — validateReceipt / validatePurchase.
 *
 * The server signals validation failures as 4xx/5xx with a structured JSON
 * body ({ valid: false, error, errorCode }). These tests pin the contract
 * that the helpers surface that body to callers (so purchaseFlow's errorCode
 * handling works) and only throw on unparseable / non-JSON responses.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ONESUB_ERROR_CODE } from '@onesub/shared';
import { validateReceipt, validatePurchase, checkStatus, checkEntitlement, REQUEST_TIMEOUT_MS } from '../api.js';
import { OneSubError } from '../OneSubError.js';

beforeEach(() => {
  vi.restoreAllMocks();
});

function mockJsonResponse(status: number, body: unknown): Response {
  return {
    ok: status < 400,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

function mockBrokenResponse(status: number): Response {
  return {
    ok: false,
    status,
    statusText: 'Bad Gateway',
    json: async () => {
      throw new SyntaxError('Unexpected token < in JSON');
    },
    text: async () => '<html>502</html>',
  } as unknown as Response;
}

describe('validateReceipt — non-2xx handling', () => {
  it('returns the structured error body instead of throwing (errorCode contract)', async () => {
    vi.spyOn(global, 'fetch').mockImplementation(async () =>
      mockJsonResponse(422, {
        valid: false,
        subscription: null,
        error: 'Receipt validation failed',
        errorCode: 'RECEIPT_VALIDATION_FAILED',
      }),
    );

    const result = await validateReceipt('https://api.example.com', {
      platform: 'apple',
      receipt: 'bad_receipt',
      userId: 'u1',
      productId: 'pro_monthly',
    });

    expect(result.valid).toBe(false);
    expect(result.error).toBe('Receipt validation failed');
    expect(result.errorCode).toBe('RECEIPT_VALIDATION_FAILED');
  });

  it('throws the generic error when the body is not parseable JSON', async () => {
    vi.spyOn(global, 'fetch').mockImplementation(async () => mockBrokenResponse(502));

    await expect(
      validateReceipt('https://api.example.com', {
        platform: 'apple',
        receipt: 'r',
        userId: 'u1',
        productId: 'pro_monthly',
      }),
    ).rejects.toThrow(/Receipt validation failed: 502/);
  });

  it('throws when a non-2xx body is JSON but not an onesub response shape (proxy/infra error)', async () => {
    // A 503 from a proxy/load balancer with its own JSON body must NOT be
    // surfaced as a validation result — `result.valid` would be undefined and
    // purchaseFlow would reject with a permanent-looking
    // RECEIPT_VALIDATION_FAILED instead of the transient INTERNAL_ERROR the
    // throw path produces.
    vi.spyOn(global, 'fetch').mockImplementation(async () =>
      mockJsonResponse(503, { message: 'upstream timeout' }),
    );

    await expect(
      validateReceipt('https://api.example.com', {
        platform: 'apple',
        receipt: 'r',
        userId: 'u1',
        productId: 'pro_monthly',
      }),
    ).rejects.toThrow(/Receipt validation failed: 503/);
  });

  it('still returns the parsed body on 2xx', async () => {
    vi.spyOn(global, 'fetch').mockImplementation(async () =>
      mockJsonResponse(200, {
        valid: true,
        subscription: { userId: 'u1', productId: 'pro_monthly', status: 'active' },
      }),
    );

    const result = await validateReceipt('https://api.example.com', {
      platform: 'apple',
      receipt: 'good',
      userId: 'u1',
      productId: 'pro_monthly',
    });

    expect(result.valid).toBe(true);
    expect(result.subscription?.productId).toBe('pro_monthly');
  });
});

describe('validatePurchase — non-2xx handling', () => {
  it('returns the structured error body instead of throwing', async () => {
    vi.spyOn(global, 'fetch').mockImplementation(async () =>
      mockJsonResponse(409, {
        valid: false,
        purchase: null,
        error: 'NON_CONSUMABLE_ALREADY_OWNED',
        errorCode: 'RECEIPT_VALIDATION_FAILED',
      }),
    );

    const result = await validatePurchase('https://api.example.com', {
      platform: 'google',
      receipt: 'token',
      userId: 'u1',
      productId: 'premium',
      type: 'non_consumable',
    });

    // The ALREADY_OWNED branch in purchaseFlow/restoreProduct depends on
    // seeing this body rather than a thrown generic Error.
    expect(result.valid).toBe(false);
    expect(result.error).toBe('NON_CONSUMABLE_ALREADY_OWNED');
  });

  it('throws the generic error when the body is not parseable JSON', async () => {
    vi.spyOn(global, 'fetch').mockImplementation(async () => mockBrokenResponse(500));

    await expect(
      validatePurchase('https://api.example.com', {
        platform: 'google',
        receipt: 'token',
        userId: 'u1',
        productId: 'premium',
        type: 'consumable',
      }),
    ).rejects.toThrow(/Purchase validation failed: 500/);
  });

  it('throws when a non-2xx body is JSON but not an onesub response shape (proxy/infra error)', async () => {
    vi.spyOn(global, 'fetch').mockImplementation(async () =>
      mockJsonResponse(429, { message: 'rate limited', retryAfter: 30 }),
    );

    await expect(
      validatePurchase('https://api.example.com', {
        platform: 'google',
        receipt: 'token',
        userId: 'u1',
        productId: 'premium',
        type: 'consumable',
      }),
    ).rejects.toThrow(/Purchase validation failed: 429/);
  });

  it('throws on network failure', async () => {
    vi.spyOn(global, 'fetch').mockImplementation(async () => {
      throw new Error('fetch failed');
    });

    await expect(
      validatePurchase('https://api.example.com', {
        platform: 'apple',
        receipt: 'token',
        userId: 'u1',
        productId: 'premium',
        type: 'consumable',
      }),
    ).rejects.toThrow(/fetch failed/);
  });
});

describe('error codes on thrown failures', () => {
  const req = {
    platform: 'apple' as const,
    receipt: 'r',
    userId: 'u1',
    productId: 'pro_monthly',
  };

  it('maps a rejected fetch to OneSubError NETWORK_ERROR', async () => {
    vi.spyOn(global, 'fetch').mockRejectedValue(new TypeError('Network request failed'));
    const err = await validateReceipt('https://api.example.com', req).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OneSubError);
    expect((err as OneSubError).code).toBe(ONESUB_ERROR_CODE.NETWORK_ERROR);
  });

  it('gives up after REQUEST_TIMEOUT_MS with NETWORK_ERROR instead of hanging', async () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(global, 'fetch').mockImplementation(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
          }),
      );
      const pending = checkStatus('https://api.example.com', 'u1').catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
      const err = await pending;
      expect(err).toBeInstanceOf(OneSubError);
      expect((err as OneSubError).code).toBe(ONESUB_ERROR_CODE.NETWORK_ERROR);
      expect((err as OneSubError).message).toMatch(/timed out/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('maps a bodyless proxy 502 to NETWORK_ERROR (transient)', async () => {
    vi.spyOn(global, 'fetch').mockImplementation(async () => mockBrokenResponse(502));
    const err = await validateReceipt('https://api.example.com', req).catch((e: unknown) => e);
    expect((err as OneSubError).code).toBe(ONESUB_ERROR_CODE.NETWORK_ERROR);
  });

  it('maps an unexpected 4xx without a onesub body to INTERNAL_ERROR', async () => {
    vi.spyOn(global, 'fetch').mockImplementation(async () => mockJsonResponse(403, { message: 'nope' }));
    const err = await checkStatus('https://api.example.com', 'u1').catch((e: unknown) => e);
    expect((err as OneSubError).code).toBe(ONESUB_ERROR_CODE.INTERNAL_ERROR);
  });

  it("keeps the server's own errorCode on a GET failure", async () => {
    vi.spyOn(global, 'fetch').mockImplementation(async () =>
      mockJsonResponse(404, { active: false, error: 'Unknown entitlement', errorCode: 'ENTITLEMENT_NOT_FOUND' }),
    );
    const notFound = await checkEntitlement('https://api.example.com', 'u1', 'nope').catch((e: unknown) => e);
    expect((notFound as OneSubError).code).toBe(ONESUB_ERROR_CODE.ENTITLEMENT_NOT_FOUND);
    expect((notFound as OneSubError).message).toMatch(/Entitlement check failed: 404/);

    // A database outage is not "check your connection".
    vi.spyOn(global, 'fetch').mockImplementation(async () =>
      mockJsonResponse(500, { active: false, subscription: null, error: 'Internal server error', errorCode: 'STORE_ERROR' }),
    );
    const storeDown = await checkStatus('https://api.example.com', 'u1').catch((e: unknown) => e);
    expect((storeDown as OneSubError).code).toBe(ONESUB_ERROR_CODE.STORE_ERROR);
  });

  it("returns the server's PROVIDER_UNAVAILABLE body untouched, so purchaseFlow keeps its errorCode", async () => {
    vi.spyOn(global, 'fetch').mockImplementation(async () =>
      mockJsonResponse(503, {
        valid: false,
        subscription: null,
        error: 'Store API unavailable — retry later',
        errorCode: 'PROVIDER_UNAVAILABLE',
      }),
    );
    const result = await validateReceipt('https://api.example.com', req);
    expect(result.errorCode).toBe('PROVIDER_UNAVAILABLE');
  });
});
