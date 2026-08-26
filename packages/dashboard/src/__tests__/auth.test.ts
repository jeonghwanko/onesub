import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openAdminSession, sealAdminSession } from '../../lib/session';
import { COOKIE_NAME } from '../../lib/session-constants';

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  redirect: vi.fn(),
  store: {
    delete: vi.fn(),
    get: vi.fn(),
    set: vi.fn(),
  },
}));

vi.mock('next/headers', () => ({ cookies: vi.fn(async () => mocks.store) }));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));
vi.mock('../../lib/onesub-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/onesub-client')>()),
  createClient: mocks.createClient,
}));

import {
  clearAdminSession,
  readAdminSession,
  requireSession,
  writeAdminSession,
} from '../../lib/auth';

const KEY = 'configured-dashboard-session-secret-with-32-plus-characters';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.store.get.mockReturnValue(undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('dashboard cookie auth', () => {
  it('writes only an encrypted, hardened session cookie in production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('ONESUB_SESSION_SECRET', KEY);

    const sessionId = await writeAdminSession('upstream-secret');
    expect(mocks.store.set).toHaveBeenCalledOnce();
    const call = mocks.store.set.mock.calls.at(0);
    if (!call) {
      throw new Error('Expected the session cookie to be written.');
    }
    const [name, token, options] = call;
    expect(name).toBe(COOKIE_NAME);
    expect(token).not.toContain('upstream-secret');
    expect(options).toEqual({
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      maxAge: 8 * 60 * 60,
      path: '/',
    });
    expect(openAdminSession(token, KEY)).toEqual(
      expect.objectContaining({ adminSecret: 'upstream-secret', sessionId }),
    );
  });

  it('rejects an explicitly configured weak key in every environment', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('ONESUB_SESSION_SECRET', 'weak');

    await expect(writeAdminSession('secret')).rejects.toThrow(/at least 32 characters/);
    expect(mocks.store.set).not.toHaveBeenCalled();
  });

  it('fails closed when production has no session key', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('ONESUB_SESSION_SECRET', '');

    await expect(writeAdminSession('secret')).rejects.toThrow(/must be set in production/);
  });

  it('decrypts a valid cookie into a server-only client and session id', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('ONESUB_SESSION_SECRET', KEY);
    vi.stubEnv('ONESUB_SERVER_URL', 'https://api.example.test');
    const { token, sessionId } = sealAdminSession('upstream-secret', KEY);
    mocks.store.get.mockReturnValue({ value: token });
    const client = { getActiveMetrics: vi.fn() };
    mocks.createClient.mockReturnValue(client);

    await expect(readAdminSession()).resolves.toEqual(
      expect.objectContaining({ adminSecret: 'upstream-secret', sessionId }),
    );
    await expect(requireSession()).resolves.toEqual({ client, sessionId });
    expect(mocks.createClient).toHaveBeenCalledWith(
      'https://api.example.test',
      'upstream-secret',
    );
  });

  it('deletes the exact session cookie', async () => {
    await clearAdminSession();
    expect(mocks.store.delete).toHaveBeenCalledWith(COOKIE_NAME);
  });
});
