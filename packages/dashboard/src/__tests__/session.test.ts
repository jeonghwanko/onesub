import { describe, expect, it } from 'vitest';
import { openAdminSession, sealAdminSession } from '../../lib/session';

const KEY = 'test-session-key-material-that-is-at-least-32-characters';

describe('dashboard admin session envelope', () => {
  it('round-trips the secret without exposing it in the cookie value', () => {
    const now = Date.UTC(2026, 0, 1);
    const { token, sessionId } = sealAdminSession('upstream-admin-secret', KEY, now);

    expect(token).not.toContain('upstream-admin-secret');
    expect(openAdminSession(token, KEY, now)).toEqual({
      adminSecret: 'upstream-admin-secret',
      sessionId,
      expiresAt: now + 8 * 60 * 60 * 1_000,
    });
  });

  it('rejects tampering, a wrong key, and expired sessions', () => {
    const now = Date.UTC(2026, 0, 1);
    const { token } = sealAdminSession('secret', KEY, now);
    const replacement = token.endsWith('A') ? 'B' : 'A';
    const tampered = `${token.slice(0, -1)}${replacement}`;

    expect(openAdminSession(tampered, KEY, now)).toBeNull();
    expect(openAdminSession(token, `${KEY}-different`, now)).toBeNull();
    expect(openAdminSession(token, KEY, now + 8 * 60 * 60 * 1_000)).toBeNull();
  });

  it('refuses weak key material', () => {
    expect(() => sealAdminSession('secret', 'too-short')).toThrow(/at least 32/);
  });
});
