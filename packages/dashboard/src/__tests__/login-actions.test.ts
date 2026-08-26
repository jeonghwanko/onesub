import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  redirect: vi.fn(() => {
    throw new Error('NEXT_REDIRECT');
  }),
  verifyAdminSecret: vi.fn(),
  writeAdminSession: vi.fn(),
}));

vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));
vi.mock('../../lib/auth', () => ({
  verifyAdminSecret: mocks.verifyAdminSecret,
  writeAdminSession: mocks.writeAdminSession,
}));

import { login } from '../../app/login/actions';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('dashboard login action', () => {
  it('rejects a missing secret before probing upstream', async () => {
    await expect(login({ error: null }, new FormData())).resolves.toEqual({
      error: 'Admin secret is required.',
    });
    expect(mocks.verifyAdminSecret).not.toHaveBeenCalled();
  });

  it('does not create a session when upstream rejects the secret', async () => {
    mocks.verifyAdminSecret.mockResolvedValue({ ok: false, reason: 'admin secret rejected' });
    const form = new FormData();
    form.set('secret', 'wrong');

    await expect(login({ error: null }, form)).resolves.toEqual({
      error: 'admin secret rejected',
    });
    expect(mocks.writeAdminSession).not.toHaveBeenCalled();
  });

  it('creates the encrypted session only after verification, then redirects', async () => {
    mocks.verifyAdminSecret.mockResolvedValue({ ok: true });
    const form = new FormData();
    form.set('secret', 'correct');

    await expect(login({ error: null }, form)).rejects.toThrow('NEXT_REDIRECT');
    expect(mocks.verifyAdminSecret).toHaveBeenCalledWith('correct');
    expect(mocks.writeAdminSession).toHaveBeenCalledWith('correct');
    expect(mocks.redirect).toHaveBeenCalledWith('/dashboard');
    const sessionWriteOrder = mocks.writeAdminSession.mock.invocationCallOrder.at(0);
    const redirectOrder = mocks.redirect.mock.invocationCallOrder.at(0);
    if (sessionWriteOrder === undefined || redirectOrder === undefined) {
      throw new Error('Expected both the session write and redirect to run.');
    }
    expect(sessionWriteOrder).toBeLessThan(redirectOrder);
  });
});
