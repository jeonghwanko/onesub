import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeAdminAudit } from '../../lib/audit';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('dashboard admin audit output', () => {
  it('emits one parseable, credential-free JSON record', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    writeAdminAudit({
      action: 'transfer_purchase',
      outcome: 'failure',
      sessionId: 'session-123',
      target: 'transaction-456',
      status: 404,
    });

    expect(info).toHaveBeenCalledOnce();
    const record = JSON.parse(String(info.mock.calls[0]?.[0]));
    expect(record).toEqual(
      expect.objectContaining({
        event: 'onesub.dashboard.admin_action',
        action: 'transfer_purchase',
        outcome: 'failure',
        sessionId: 'session-123',
        target: 'transaction-456',
        status: 404,
      }),
    );
    expect(Number.isNaN(Date.parse(record.timestamp))).toBe(false);
    expect(JSON.stringify(record)).not.toMatch(/adminSecret|upstream-secret/);
  });
});
