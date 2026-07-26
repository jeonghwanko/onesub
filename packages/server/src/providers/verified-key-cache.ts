import { createHash } from 'node:crypto';

/**
 * Memo for "this certificate chain was verified, and here is the key it
 * authorises" — the result of an expensive, purely local verification.
 *
 * Why this exists: Apple's StoreKit JWS verification re-parses the x5c chain,
 * re-checks every issuer signature against a bundled Apple root, and re-imports
 * the leaf public key on EVERY receipt and EVERY webhook. All of it is
 * synchronous CPU work on the event loop, and Apple's leaf certificates are
 * stable for weeks — so the same chain is verified over and over with the same
 * outcome.
 *
 * Why this is NOT the pluggable `CacheAdapter`: that adapter exists to share
 * *rate-limited network* results (Apple API JWTs, Google OAuth tokens) between
 * cluster nodes, and it serialises values as JSON. An imported key is not
 * JSON-serialisable — a Redis-backed adapter would silently round-trip it to
 * `{}` — and what is being avoided here is local CPU, not a network call or a
 * quota. A Redis round-trip would plausibly cost more than the verification it
 * replaces. So this cache is deliberately process-local.
 *
 * Security invariants, all enforced below and covered by tests:
 *
 *   - The entry key covers EVERY input to the verification, including the
 *     algorithm the key was imported for. A different chain, or the same chain
 *     claiming a different `alg`, is a different entry — it can never reuse a
 *     key that was authorised for something else.
 *   - A failed verification is never stored. A rejected `produce` propagates and
 *     leaves the cache untouched, so a bad chain is re-verified (and re-rejected)
 *     every time rather than being remembered either way.
 *   - No entry outlives the chain that produced it. `notAfter` (the earliest
 *     expiry in the verified chain) is a hard ceiling on the entry's lifetime,
 *     so an expired certificate can never be served from cache.
 */

/** What a successful verification yields: the key, and when it stops being valid. */
export interface VerifiedKey<K> {
  key: K;
  /**
   * Earliest `notAfter` across the verified chain, as ms-since-epoch. The cache
   * entry is dropped at or before this instant, never after it.
   */
  notAfter: number;
}

export interface VerifiedKeyCacheOptions {
  /**
   * Upper bound on entries. Only successfully verified chains are stored, so in
   * practice this holds a handful (Apple production + sandbox leaves, across a
   * rotation). The cap is defence in depth against unbounded growth.
   */
  maxEntries?: number;
  /** Upper bound on an entry's lifetime, independent of certificate expiry. */
  maxTtlMs?: number;
  /** Injectable clock. Tests drive expiry with it; production uses `Date.now`. */
  now?: () => number;
}

interface Entry<K> {
  key: K;
  /** ms-since-epoch; never greater than the chain's own `notAfter`. */
  expiresAt: number;
}

const DEFAULT_MAX_ENTRIES = 32;
const DEFAULT_MAX_TTL_MS = 60 * 60 * 1000; // 1 hour

export class VerifiedKeyCache<K> {
  private readonly entries = new Map<string, Entry<K>>();
  private readonly maxEntries: number;
  private readonly maxTtlMs: number;
  private readonly now: () => number;

  constructor(opts: VerifiedKeyCacheOptions = {}) {
    this.maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.maxTtlMs = opts.maxTtlMs ?? DEFAULT_MAX_TTL_MS;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Return the key for `parts`, verifying via `produce` only on a miss.
   *
   * `parts` must contain every input the verification depends on — for Apple
   * that is the JWS `alg` plus the full x5c chain. Anything left out would let
   * one input's result be served for a different input.
   */
  async resolve(parts: readonly string[], produce: () => Promise<VerifiedKey<K>>): Promise<K> {
    const cacheKey = digest(parts);
    const now = this.now();

    const hit = this.entries.get(cacheKey);
    if (hit) {
      if (hit.expiresAt > now) return hit.key;
      // Past its ceiling — drop it and fall through to a full re-verification
      // rather than serving a key whose chain may have expired.
      this.entries.delete(cacheKey);
    }

    // A throw here propagates untouched and stores nothing: an unverifiable
    // chain must never become a cache entry, positive or negative.
    const verified = await produce();

    const expiresAt = Math.min(now + this.maxTtlMs, verified.notAfter);
    // Already at or past its ceiling (a chain expiring within this instant):
    // usable right now, but not worth remembering.
    if (expiresAt > now) {
      this.prune(now);
      this.entries.set(cacheKey, { key: verified.key, expiresAt });
    }
    return verified.key;
  }

  /** Entries currently held, including any not yet pruned. Test/diagnostic use. */
  get size(): number {
    return this.entries.size;
  }

  /** Drop everything. Test/diagnostic use. */
  clear(): void {
    this.entries.clear();
  }

  /** Make room: expired entries first, then the oldest insertions. */
  private prune(now: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
    // Map iterates in insertion order, so `keys().next()` is the oldest.
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }
}

/**
 * Collision-resistant key for an ordered list of strings.
 *
 * Each part is length-prefixed so that concatenation is unambiguous — without
 * it, `['a', 'bc']` and `['ab', 'c']` would hash identically, and for this cache
 * that would mean one chain's verified key being served for another.
 */
function digest(parts: readonly string[]): string {
  const hash = createHash('sha256');
  for (const part of parts) {
    hash.update(String(part.length));
    hash.update(':');
    hash.update(part);
  }
  return hash.digest('base64');
}
