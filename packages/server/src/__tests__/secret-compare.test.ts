import { describe, expect, it } from 'vitest';
import { secretsEqual } from '../routes/secret-compare.js';

/**
 * Timing-safe shared-secret comparison used by the admin, metrics, and Apple
 * offer routes. Behavioral contract only — actual timing characteristics come
 * from crypto.timingSafeEqual.
 */
describe('secretsEqual', () => {
  it('returns true for identical secrets', () => {
    expect(secretsEqual('s3cr3t', 's3cr3t')).toBe(true);
  });

  it('returns false for same-length different secrets', () => {
    expect(secretsEqual('s3cr3t', 's3cr3T')).toBe(false);
  });

  it('returns false on length mismatch (no throw from timingSafeEqual)', () => {
    expect(secretsEqual('short', 'a-much-longer-secret')).toBe(false);
    expect(secretsEqual('a-much-longer-secret', 'short')).toBe(false);
    expect(secretsEqual('', 'x')).toBe(false);
  });

  it('returns true for empty vs empty (caller guards non-string/absent input)', () => {
    expect(secretsEqual('', '')).toBe(true);
  });

  it('compares by UTF-8 bytes, so multi-byte secrets work', () => {
    expect(secretsEqual('sécret-키', 'sécret-키')).toBe(true);
    expect(secretsEqual('sécret-키', 'sécret-키!')).toBe(false);
  });
});
