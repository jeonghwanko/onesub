/**
 * VerifiedKeyCache — the memo behind Apple x5c chain verification.
 *
 * This cache sits directly on a security boundary: it decides when an
 * expensive chain verification may be skipped. The real Apple path cannot be
 * driven end-to-end in tests (a passing chain must be signed by Apple's private
 * keys, and `verifyAppleCertChain` correctly refuses anything else), so the
 * cache takes its verification as an injected function and the invariants are
 * tested here directly:
 *
 *   - a hit skips verification, a miss does not
 *   - every input participates in the entry identity (chain AND alg)
 *   - a failed verification is never remembered
 *   - no entry outlives the certificate chain that produced it
 *   - eviction never hands back a stale key
 */

import { describe, it, expect } from 'vitest';
import { VerifiedKeyCache } from '../providers/verified-key-cache.js';

const HOUR_MS = 60 * 60 * 1000;

/** A verifier that counts calls and hands back a labelled key. */
function stubVerifier(label: string, notAfter: number) {
  let calls = 0;
  return {
    calls: () => calls,
    produce: async () => {
      calls++;
      return { key: `key:${label}`, notAfter };
    },
  };
}

describe('VerifiedKeyCache — hit / miss', () => {
  it('verifies once for repeated identical input', async () => {
    const cache = new VerifiedKeyCache<string>({ now: () => 1_000 });
    const v = stubVerifier('leaf', 1_000 + 10 * HOUR_MS);

    const first = await cache.resolve(['ES256', 'certA'], v.produce);
    const second = await cache.resolve(['ES256', 'certA'], v.produce);
    const third = await cache.resolve(['ES256', 'certA'], v.produce);

    expect(first).toBe('key:leaf');
    expect(second).toBe('key:leaf');
    expect(third).toBe('key:leaf');
    expect(v.calls()).toBe(1);
  });

  it('re-verifies when any part of the chain differs', async () => {
    const cache = new VerifiedKeyCache<string>({ now: () => 1_000 });
    const v = stubVerifier('leaf', 1_000 + 10 * HOUR_MS);

    await cache.resolve(['ES256', 'certA', 'interA'], v.produce);
    await cache.resolve(['ES256', 'certA', 'interB'], v.produce);
    await cache.resolve(['ES256', 'certA'], v.produce);

    expect(v.calls()).toBe(3);
  });

  it('treats the same chain under a different alg as a different entry', async () => {
    // Otherwise a key imported for ES256 could be served to a caller claiming
    // RS256 — the cache would be laundering an algorithm substitution.
    const cache = new VerifiedKeyCache<string>({ now: () => 1_000 });
    const v = stubVerifier('leaf', 1_000 + 10 * HOUR_MS);

    await cache.resolve(['ES256', 'certA'], v.produce);
    await cache.resolve(['RS256', 'certA'], v.produce);

    expect(v.calls()).toBe(2);
  });

  it('does not let part boundaries collide', async () => {
    // ['a','bc'] and ['ab','c'] concatenate identically; length-prefixed
    // hashing must still separate them.
    const cache = new VerifiedKeyCache<string>({ now: () => 1_000 });
    const v = stubVerifier('leaf', 1_000 + 10 * HOUR_MS);

    await cache.resolve(['a', 'bc'], v.produce);
    await cache.resolve(['ab', 'c'], v.produce);

    expect(v.calls()).toBe(2);
    expect(cache.size).toBe(2);
  });
});

describe('VerifiedKeyCache — failures are never cached', () => {
  it('propagates the rejection and stores nothing', async () => {
    const cache = new VerifiedKeyCache<string>({ now: () => 1_000 });
    let calls = 0;
    const failing = async (): Promise<{ key: string; notAfter: number }> => {
      calls++;
      throw new Error('cert chain does not terminate at a trusted Apple root');
    };

    await expect(cache.resolve(['ES256', 'bad'], failing)).rejects.toThrow(/trusted Apple root/);
    expect(cache.size).toBe(0);

    // A second attempt must re-verify (and re-reject) rather than being served
    // any remembered outcome.
    await expect(cache.resolve(['ES256', 'bad'], failing)).rejects.toThrow(/trusted Apple root/);
    expect(calls).toBe(2);
    expect(cache.size).toBe(0);
  });

  it('a later success for the same input is cached normally', async () => {
    const cache = new VerifiedKeyCache<string>({ now: () => 1_000 });
    await expect(
      cache.resolve(['ES256', 'certA'], async () => {
        throw new Error('transient');
      }),
    ).rejects.toThrow(/transient/);

    const v = stubVerifier('leaf', 1_000 + 10 * HOUR_MS);
    expect(await cache.resolve(['ES256', 'certA'], v.produce)).toBe('key:leaf');
    expect(await cache.resolve(['ES256', 'certA'], v.produce)).toBe('key:leaf');
    expect(v.calls()).toBe(1);
  });
});

describe('VerifiedKeyCache — entries never outlive the chain', () => {
  it('expires at the chain notAfter even when maxTtl is longer', async () => {
    let clock = 1_000;
    const certExpiry = clock + 5 * 60 * 1000; // 5 minutes of certificate left
    const cache = new VerifiedKeyCache<string>({ maxTtlMs: 10 * HOUR_MS, now: () => clock });
    const v = stubVerifier('leaf', certExpiry);

    await cache.resolve(['ES256', 'certA'], v.produce);
    expect(v.calls()).toBe(1);

    // Still inside the certificate's validity → served from cache.
    clock = certExpiry - 1;
    await cache.resolve(['ES256', 'certA'], v.produce);
    expect(v.calls()).toBe(1);

    // Certificate has now expired. The cache must NOT answer from memory —
    // full verification runs again (and in production would throw).
    clock = certExpiry + 1;
    await cache.resolve(['ES256', 'certA'], v.produce);
    expect(v.calls()).toBe(2);
  });

  it('caps the lifetime at maxTtl even for a long-lived certificate', async () => {
    let clock = 1_000;
    const cache = new VerifiedKeyCache<string>({ maxTtlMs: HOUR_MS, now: () => clock });
    const v = stubVerifier('leaf', clock + 365 * 24 * HOUR_MS);

    await cache.resolve(['ES256', 'certA'], v.produce);
    clock += HOUR_MS - 1;
    await cache.resolve(['ES256', 'certA'], v.produce);
    expect(v.calls()).toBe(1);

    clock += 2;
    await cache.resolve(['ES256', 'certA'], v.produce);
    expect(v.calls()).toBe(2);
  });

  it('does not store a chain that expires at this instant', async () => {
    const clock = 1_000;
    const cache = new VerifiedKeyCache<string>({ now: () => clock });
    const v = stubVerifier('leaf', clock);

    // The key is still returned — the verification did pass — but remembering
    // it would be remembering something already out of validity.
    expect(await cache.resolve(['ES256', 'certA'], v.produce)).toBe('key:leaf');
    expect(cache.size).toBe(0);
  });

  it('never caches when the expiry could not be established', async () => {
    // The Apple verifier reports notAfter 0 when a certificate's validity end
    // cannot be parsed. "Unknown expiry" must mean "re-verify every time",
    // never "hold it for the default TTL".
    const clock = 1_000;
    const cache = new VerifiedKeyCache<string>({ now: () => clock });
    const v = stubVerifier('leaf', 0);

    expect(await cache.resolve(['ES256', 'certA'], v.produce)).toBe('key:leaf');
    expect(await cache.resolve(['ES256', 'certA'], v.produce)).toBe('key:leaf');
    expect(cache.size).toBe(0);
    expect(v.calls()).toBe(2);
  });
});

describe('VerifiedKeyCache — bounded', () => {
  it('stays within maxEntries and keeps serving correct keys', async () => {
    let clock = 1_000;
    const cache = new VerifiedKeyCache<string>({ maxEntries: 3, now: () => clock });

    for (let i = 0; i < 10; i++) {
      const v = stubVerifier(`leaf${i}`, clock + 10 * HOUR_MS);
      expect(await cache.resolve(['ES256', `cert${i}`], v.produce)).toBe(`key:leaf${i}`);
      expect(cache.size).toBeLessThanOrEqual(3);
    }

    // The most recent entry is still a hit; an evicted one re-verifies rather
    // than returning some other chain's key.
    const recent = stubVerifier('leaf9-again', clock + 10 * HOUR_MS);
    expect(await cache.resolve(['ES256', 'cert9'], recent.produce)).toBe('key:leaf9');
    expect(recent.calls()).toBe(0);

    const evicted = stubVerifier('leaf0-again', clock + 10 * HOUR_MS);
    expect(await cache.resolve(['ES256', 'cert0'], evicted.produce)).toBe('key:leaf0-again');
    expect(evicted.calls()).toBe(1);
  });

  it('clear() drops everything', async () => {
    const cache = new VerifiedKeyCache<string>({ now: () => 1_000 });
    const v = stubVerifier('leaf', 1_000 + 10 * HOUR_MS);
    await cache.resolve(['ES256', 'certA'], v.produce);
    expect(cache.size).toBe(1);

    cache.clear();
    expect(cache.size).toBe(0);

    await cache.resolve(['ES256', 'certA'], v.produce);
    expect(v.calls()).toBe(2);
  });
});
