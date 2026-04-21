import { X509Certificate } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import {
  APPLE_ROOT_CA_G3_PEM,
  APPLE_ROOT_CA_PEMS,
} from '../providers/apple-root-ca.js';

/**
 * Protects against accidental deletion when Apple publishes Root CA G4 and
 * someone "replaces" G3 instead of appending. StoreKit 2 receipts signed
 * under the older root must keep validating after G4 ships.
 */
describe('Apple Root CA bundle', () => {
  it('includes at least one root', () => {
    expect(APPLE_ROOT_CA_PEMS.length).toBeGreaterThan(0);
  });

  it('includes G3 verbatim (retained even after G4 is added)', () => {
    expect(APPLE_ROOT_CA_PEMS).toContain(APPLE_ROOT_CA_G3_PEM);
  });

  it('every bundled root is a parseable X.509 certificate', () => {
    for (const pem of APPLE_ROOT_CA_PEMS) {
      expect(() => new X509Certificate(pem)).not.toThrow();
    }
  });

  it('every bundled root is currently within its validity window', () => {
    const now = Date.now();
    for (const pem of APPLE_ROOT_CA_PEMS) {
      const cert = new X509Certificate(pem);
      const notBefore = Date.parse(cert.validFrom);
      const notAfter = Date.parse(cert.validTo);
      expect(notBefore).toBeLessThanOrEqual(now);
      expect(notAfter).toBeGreaterThan(now);
    }
  });

  it('G3 is self-signed by Apple (issuer matches subject)', () => {
    const cert = new X509Certificate(APPLE_ROOT_CA_G3_PEM);
    expect(cert.issuer).toBe(cert.subject);
    expect(cert.subject).toContain('Apple Root CA - G3');
  });

  it('no duplicate PEMs in the bundle', () => {
    const set = new Set(APPLE_ROOT_CA_PEMS);
    expect(set.size).toBe(APPLE_ROOT_CA_PEMS.length);
  });
});
