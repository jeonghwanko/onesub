import { timingSafeEqual } from 'node:crypto';

/**
 * Constant-time comparison for shared secrets (admin secret, offer secret).
 *
 * A plain `!==` short-circuits on the first differing byte, letting an
 * attacker recover the secret byte-by-byte from response timing.
 * `crypto.timingSafeEqual` requires equal-length buffers, so a length
 * mismatch returns `false` immediately — this leaks only the secret's
 * LENGTH (not its content), which is an accepted trade-off.
 */
export function secretsEqual(provided: string, expected: string): boolean {
  const providedBuf = Buffer.from(provided, 'utf8');
  const expectedBuf = Buffer.from(expected, 'utf8');
  if (providedBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(providedBuf, expectedBuf);
}
