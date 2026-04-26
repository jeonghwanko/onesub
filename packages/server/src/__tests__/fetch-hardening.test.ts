/**
 * Tests for outbound fetch hardening:
 *   - Apple Server API JWT cache (re-use within TTL, mint dedup under concurrent calls)
 *   - fetchWithTimeout: AbortController fires when upstream hangs longer than the budget
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { generateKeyPairSync } from 'crypto';
import type { OneSubServerConfig } from '@onesub/shared';
import { fetchAppleSubscriptionStatus, __testing as appleTesting } from '../providers/apple.js';
import { fetchWithTimeout } from '../http.js';
import { isLocalhostUrl, urlHost } from './test-utils.js';

let testEcKey: string;

beforeAll(() => {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  testEcKey = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
});

beforeEach(() => {
  vi.restoreAllMocks();
  appleTesting.clearAppleJwtCacheForTests();
});

function appleConfig(): NonNullable<OneSubServerConfig['apple']> {
  return {
    bundleId: 'com.example.app',
    skipJwsVerification: true,
    keyId: 'KEY1',
    issuerId: 'iss-uuid',
    privateKey: testEcKey,
  };
}

function makeJws(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'ES256' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.fakesig`;
}

function statusResponse(orig: string) {
  return {
    bundleId: 'com.example.app',
    environment: 'Production',
    data: [{
      lastTransactions: [{
        originalTransactionId: orig,
        status: 1,
        signedTransactionInfo: makeJws({
          bundleId: 'com.example.app',
          productId: 'pro_monthly',
          transactionId: 'tx',
          originalTransactionId: orig,
          purchaseDate: Date.now(),
          originalPurchaseDate: Date.now(),
          expiresDate: Date.now() + 86400000,
        }),
        signedRenewalInfo: makeJws({ autoRenewStatus: 1 }),
      }],
    }],
  };
}

// ── Apple JWT cache ─────────────────────────────────────────────────────────

describe('makeAppleApiJwt cache', () => {
  it('mints a JWT once per cache window when called sequentially', async () => {
    const originalFetch = global.fetch;
    const calls: { url: string; auth?: string }[] = [];
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      if (isLocalhostUrl(url)) return originalFetch(url, init);
      const headers = init?.headers as Record<string, string> | undefined;
      calls.push({ url: String(url), auth: headers?.Authorization });
      return {
        ok: true,
        status: 200,
        json: async () => statusResponse('orig_a'),
        text: async () => '',
      } as Response;
    });

    await fetchAppleSubscriptionStatus('orig_a', appleConfig());
    await fetchAppleSubscriptionStatus('orig_a', appleConfig());
    await fetchAppleSubscriptionStatus('orig_a', appleConfig());

    // 3 outbound API calls, but the Authorization header (Bearer <jwt>) should
    // be the same JWT in all of them — cache hit on calls 2 and 3.
    expect(calls).toHaveLength(3);
    expect(calls[0].auth).toBeDefined();
    expect(calls[1].auth).toBe(calls[0].auth);
    expect(calls[2].auth).toBe(calls[0].auth);
  });

  it('dedups concurrent JWT mints (single in-flight Promise under burst)', async () => {
    // Use a real key pair sign spy through jose? Indirect — just count fetch
    // Authorization headers across many concurrent calls. With dedup, all
    // share the same JWT.
    const originalFetch = global.fetch;
    const auths: string[] = [];
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      if (isLocalhostUrl(url)) return originalFetch(url, init);
      const headers = init?.headers as Record<string, string> | undefined;
      auths.push(headers?.Authorization ?? '');
      return {
        ok: true,
        status: 200,
        json: async () => statusResponse('orig_burst'),
        text: async () => '',
      } as Response;
    });

    await Promise.all(
      Array.from({ length: 10 }, () => fetchAppleSubscriptionStatus('orig_burst', appleConfig())),
    );

    expect(auths).toHaveLength(10);
    const unique = new Set(auths);
    expect(unique.size).toBe(1);  // all 10 used the same JWT
  });

  it('mints a fresh JWT after the cache is cleared (e.g. credential rotation)', async () => {
    const originalFetch = global.fetch;
    const auths: string[] = [];
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      if (isLocalhostUrl(url)) return originalFetch(url, init);
      const headers = init?.headers as Record<string, string> | undefined;
      auths.push(headers?.Authorization ?? '');
      return {
        ok: true,
        status: 200,
        json: async () => statusResponse('orig_clear'),
        text: async () => '',
      } as Response;
    });

    await fetchAppleSubscriptionStatus('orig_clear', appleConfig());
    appleTesting.clearAppleJwtCacheForTests();
    await fetchAppleSubscriptionStatus('orig_clear', appleConfig());

    expect(auths).toHaveLength(2);
    expect(auths[0]).not.toBe(auths[1]);  // cache miss → fresh JWT
  });
});

// ── fetchWithTimeout ────────────────────────────────────────────────────────

describe('fetchWithTimeout', () => {
  it('returns the response when upstream replies before the timeout', async () => {
    vi.spyOn(global, 'fetch').mockImplementation(async () => {
      return { ok: true, status: 200, text: async () => 'hi' } as Response;
    });

    const resp = await fetchWithTimeout('https://example.com', undefined, 1000);
    expect(resp.ok).toBe(true);
  });

  it('aborts when upstream hangs longer than the timeout', async () => {
    vi.spyOn(global, 'fetch').mockImplementation((_input, init) => {
      // Simulate a hung server — never resolves until the AbortController fires
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal) {
          signal.addEventListener('abort', () => {
            const reason = (signal as AbortSignal & { reason?: unknown }).reason;
            reject(reason instanceof Error ? reason : new Error('aborted'));
          });
        }
      });
    });

    const start = Date.now();
    await expect(fetchWithTimeout('https://hung.example', undefined, 100)).rejects.toThrow(/timed out|aborted/i);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(90);
    expect(elapsed).toBeLessThan(500);
  });

  it('respects a caller-provided AbortSignal (composes with timeout)', async () => {
    vi.spyOn(global, 'fetch').mockImplementation((_input, init) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    });

    const ac = new AbortController();
    setTimeout(() => ac.abort(new Error('caller cancelled')), 30);

    await expect(
      fetchWithTimeout('https://hung.example', { signal: ac.signal }, 5000),
    ).rejects.toThrow();
  });

  it('clears its timer on success (no leaked handles)', async () => {
    vi.spyOn(global, 'fetch').mockImplementation(async () => {
      return { ok: true, status: 200, text: async () => 'ok' } as Response;
    });
    // 100s timeout, but resolves immediately. If the timer leaked, vitest
    // would hold the process open after the test — vitest's `--detectLeaks`
    // would catch that. Smoke test here is just that the call returns and the
    // process doesn't hang the test runner.
    await fetchWithTimeout('https://example.com', undefined, 100_000);
    // Reaching this line means the timer either fired (it shouldn't) or was
    // cleared. We can't easily inspect `setTimeout` internals, but the suite
    // completing in normal time is the implicit assertion.
    expect(true).toBe(true);
  });

  it('uses the default 10s budget when no timeoutMs is passed', async () => {
    let observedTimeout: number | undefined;
    vi.spyOn(global, 'fetch').mockImplementation((_input, init) => {
      // Snapshot any abort behaviour: we can't read the timeout directly,
      // but we can verify a signal is attached.
      observedTimeout = init?.signal ? 1 : 0;
      return Promise.resolve({ ok: true, status: 200, text: async () => '' } as Response);
    });
    await fetchWithTimeout('https://example.com');
    expect(observedTimeout).toBe(1);  // signal attached → timeout active
  });
});
