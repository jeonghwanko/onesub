/**
 * decodeJws — the cached chain-verification wiring.
 *
 * The success path cannot be exercised here: a chain that passes
 * `verifyAppleCertChain` must be signed by Apple's private keys, and the
 * verifier correctly refuses everything else. The cache's own behaviour is
 * tested in isolation in `verified-key-cache.test.ts` (with an injected
 * verifier). What this file pins down is the part that only the real function
 * can show — that introducing a cache did not weaken rejection:
 *
 *   - a chain that fails verification is rejected EVERY time, not remembered
 *   - a missing x5c is still rejected
 *   - `skipVerification` still bypasses the whole path
 */

import { describe, it, expect } from 'vitest';
import { decodeJws, clearAppleCertCache } from '../providers/apple.js';

/** base64url without padding, as used in JWS. */
function b64url(input: string): string {
  return Buffer.from(input, 'utf-8').toString('base64url');
}

/**
 * A syntactically valid JWS whose x5c is not an Apple chain. The signature is
 * never reached — chain verification fails first — so it can be any value.
 */
function jwsWithX5c(x5c: string[] | undefined, payload: Record<string, unknown> = { bundleId: 'com.example.app' }): string {
  const header: Record<string, unknown> = { alg: 'ES256', typ: 'JWT' };
  if (x5c) header['x5c'] = x5c;
  return `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}.c2ln`;
}

// Well-formed base64 that is not a certificate — `new X509Certificate()`
// rejects it, which is the first thing chain verification does.
const NOT_A_CERT = Buffer.from('this is not a DER certificate').toString('base64');

describe('decodeJws — untrusted chains are rejected every time', () => {
  it('rejects a non-Apple chain, and keeps rejecting it on repeat calls', async () => {
    clearAppleCertCache();
    const jws = jwsWithX5c([NOT_A_CERT]);

    // Three identical attempts. If a failed verification were ever cached — or
    // if a cache lookup could short-circuit verification for an unverified
    // chain — a later call would stop throwing.
    await expect(decodeJws(jws)).rejects.toThrow();
    await expect(decodeJws(jws)).rejects.toThrow();
    await expect(decodeJws(jws)).rejects.toThrow();
  });

  it('rejects a multi-cert chain that does not terminate at an Apple root', async () => {
    clearAppleCertCache();
    const jws = jwsWithX5c([NOT_A_CERT, NOT_A_CERT, NOT_A_CERT]);
    await expect(decodeJws(jws)).rejects.toThrow();
    await expect(decodeJws(jws)).rejects.toThrow();
  });

  it('rejects a chain claiming a different alg just the same', async () => {
    clearAppleCertCache();
    const header = { alg: 'RS256', typ: 'JWT', x5c: [NOT_A_CERT] };
    const jws = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify({ bundleId: 'x' }))}.c2ln`;
    await expect(decodeJws(jws)).rejects.toThrow();
    await expect(decodeJws(jws)).rejects.toThrow();
  });

  it('rejects a JWS with no x5c header', async () => {
    clearAppleCertCache();
    await expect(decodeJws(jwsWithX5c(undefined))).rejects.toThrow(/missing x5c/);
  });

  it('rejects an empty x5c array', async () => {
    clearAppleCertCache();
    await expect(decodeJws(jwsWithX5c([]))).rejects.toThrow(/missing x5c/);
  });
});

describe('decodeJws — skipVerification is unaffected by the cache', () => {
  it('returns the decoded payload without touching the chain', async () => {
    clearAppleCertCache();
    const payload = { bundleId: 'com.example.app', productId: 'pro_monthly' };
    // Same bogus x5c that fails above — skipVerification must not consult it.
    const decoded = await decodeJws<typeof payload>(jwsWithX5c([NOT_A_CERT], payload), true);
    expect(decoded.bundleId).toBe('com.example.app');
    expect(decoded.productId).toBe('pro_monthly');
  });

  it('still decodes when there is no x5c at all', async () => {
    const payload = { bundleId: 'com.example.app' };
    const decoded = await decodeJws<typeof payload>(jwsWithX5c(undefined, payload), true);
    expect(decoded.bundleId).toBe('com.example.app');
  });
});
