/**
 * BasicConstraints enforcement for x5c issuer certificates.
 *
 * `verifyAppleCertChain` walks the JWS x5c chain and every certificate that
 * SIGNS another one (index >= 1, plus the bundled Apple root when used as
 * issuer) must carry basicConstraints CA=true — otherwise an Apple-issued
 * leaf certificate could sign a forged leaf and splice it into a chain that
 * still terminates at the trusted root.
 *
 * Node's crypto module cannot mint X.509 certificates, so building a real
 * malicious chain in-test would require an external CA dependency. Instead
 * the constraint check lives in the exported pure function
 * `assertIssuerCanSign`, unit-tested here directly (mock-shaped objects for
 * the negative path, the real bundled Apple root for the positive path).
 */

import { X509Certificate } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { assertIssuerCanSign } from '../providers/apple.js';
import { APPLE_ROOT_CA_G3_PEM, APPLE_ROOT_CA_PEMS } from '../providers/apple-root-ca.js';

describe('assertIssuerCanSign', () => {
  it('rejects an issuer certificate that is not a CA', () => {
    const nonCaIssuer = { ca: false } as Pick<X509Certificate, 'ca'>;
    expect(() => assertIssuerCanSign(nonCaIssuer, 1)).toThrow(/cert\[1\].*not a CA/);
  });

  it('reports the chain index of the offending certificate', () => {
    const nonCaIssuer = { ca: false } as Pick<X509Certificate, 'ca'>;
    expect(() => assertIssuerCanSign(nonCaIssuer, 2)).toThrow(/cert\[2\]/);
  });

  it('accepts a CA issuer certificate', () => {
    const caIssuer = { ca: true } as Pick<X509Certificate, 'ca'>;
    expect(() => assertIssuerCanSign(caIssuer, 1)).not.toThrow();
  });

  it('the bundled Apple Root CA G3 passes the guard (real certificate)', () => {
    const root = new X509Certificate(APPLE_ROOT_CA_G3_PEM);
    expect(root.ca).toBe(true);
    expect(() => assertIssuerCanSign(root, 2)).not.toThrow();
  });

  it('every bundled Apple root is a CA (would be rejected as issuer otherwise)', () => {
    for (const pem of APPLE_ROOT_CA_PEMS) {
      const cert = new X509Certificate(pem);
      expect(cert.ca).toBe(true);
    }
  });

  it('documents why keyCertSign is not checked: node keyUsage returns EKU, not KeyUsage bits', () => {
    // Apple Root CA G3 definitely carries KeyUsage keyCertSign, yet node's
    // X509Certificate.keyUsage reads the Extended Key Usage extension (absent
    // on CA certs) and returns undefined — so `.ca` is the only reliable
    // signal. If a future node version starts returning KeyUsage bits here,
    // this test flags that assertIssuerCanSign can be tightened.
    const root = new X509Certificate(APPLE_ROOT_CA_G3_PEM);
    expect(root.keyUsage).toBeUndefined();
  });
});
