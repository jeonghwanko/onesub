import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  clearAdminSession: vi.fn(),
  requireSession: vi.fn(),
  revalidatePath: vi.fn(),
  writeAdminAudit: vi.fn(),
}));

vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock('../../lib/auth', () => ({
  clearAdminSession: mocks.clearAdminSession,
  requireSession: mocks.requireSession,
}));
vi.mock('../../lib/audit', () => ({ writeAdminAudit: mocks.writeAdminAudit }));

import {
  deletePurchasesAction,
  grantPurchaseAction,
  transferPurchaseAction,
} from '../../lib/admin-actions';
import { OneSubFetchError } from '../../lib/onesub-client';

const client = {
  grantPurchase: vi.fn(),
  transferPurchase: vi.fn(),
  deletePurchases: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireSession.mockResolvedValue({ client, sessionId: 'session-123' });
});

describe('dashboard admin actions', () => {
  it('grants a purchase and writes a secret-free success audit event', async () => {
    const form = new FormData();
    form.set('userId', 'user-1');
    form.set('productId', 'pro');
    form.set('platform', 'apple');
    form.set('type', 'non_consumable');

    await expect(grantPurchaseAction(null, form)).resolves.toEqual({ ok: true });
    expect(client.grantPurchase).toHaveBeenCalledWith({
      userId: 'user-1',
      productId: 'pro',
      platform: 'apple',
      type: 'non_consumable',
      transactionId: undefined,
    });
    expect(mocks.writeAdminAudit).toHaveBeenCalledWith({
      action: 'grant_purchase',
      target: 'user-1:pro',
      sessionId: 'session-123',
      outcome: 'success',
    });
  });

  it('transfers and deletes through their explicit client methods', async () => {
    const transfer = new FormData();
    transfer.set('transactionId', 'tx-1');
    transfer.set('newUserId', 'user-2');
    transfer.set('fromUserId', 'user-1');
    await expect(transferPurchaseAction(null, transfer)).resolves.toEqual({ ok: true });
    expect(client.transferPurchase).toHaveBeenCalledWith('tx-1', 'user-2');

    const deletion = new FormData();
    deletion.set('userId', 'user-2');
    deletion.set('productId', 'pro');
    await expect(deletePurchasesAction(null, deletion)).resolves.toEqual({ ok: true });
    expect(client.deletePurchases).toHaveBeenCalledWith('user-2', 'pro');
  });

  it('logs upstream failures and clears an invalid session', async () => {
    client.deletePurchases.mockRejectedValueOnce(new OneSubFetchError(401, 'rejected'));
    const form = new FormData();
    form.set('userId', 'user-1');
    form.set('productId', 'pro');

    await expect(deletePurchasesAction(null, form)).resolves.toEqual({ ok: false, error: 'rejected' });
    expect(mocks.clearAdminSession).toHaveBeenCalledOnce();
    expect(mocks.writeAdminAudit).toHaveBeenCalledWith({
      action: 'delete_purchases',
      target: 'user-1:pro',
      sessionId: 'session-123',
      outcome: 'failure',
      status: 401,
    });
  });

  it('rejects malformed input before any privileged call', async () => {
    await expect(deletePurchasesAction(null, new FormData())).resolves.toEqual({
      ok: false,
      error: 'userId / productId 누락',
    });
    expect(mocks.requireSession).not.toHaveBeenCalled();
    expect(mocks.writeAdminAudit).not.toHaveBeenCalled();
  });
});
