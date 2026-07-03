/**
 * productReceiptMaxAgeHours — the one-time-purchase replay window is
 * configurable (default 72h) so historical receipts can be validated on
 * purpose (backend migrations, e2e against real store transactions).
 */

import { describe, it, expect } from 'vitest';
import { validateAppleConsumableReceipt } from '../providers/apple.js';

function makeJws(payload: Record<string, unknown>): string {
  const b64 = (o: Record<string, unknown>) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'ES256' })}.${b64(payload)}.sig`;
}

const DAYS = 24 * 60 * 60 * 1000;

const agedReceipt = () => makeJws({
  bundleId: 'com.example.app',
  type: 'Non-Consumable',
  productId: 'welcome_pass',
  transactionId: 'tx_aged_1',
  originalTransactionId: 'tx_aged_1',
  purchaseDate: Date.now() - 30 * DAYS,
  environment: 'Production',
});

describe('validateAppleConsumableReceipt — receipt age window', () => {
  it('rejects receipts older than the default 72h window', async () => {
    const result = await validateAppleConsumableReceipt(agedReceipt(), {
      bundleId: 'com.example.app', skipJwsVerification: true,
    });
    expect(result).toBeNull();
  });

  it('accepts aged receipts when productReceiptMaxAgeHours is raised', async () => {
    const result = await validateAppleConsumableReceipt(agedReceipt(), {
      bundleId: 'com.example.app', skipJwsVerification: true,
      productReceiptMaxAgeHours: 24 * 365,
    });
    expect(result?.transactionId).toBe('tx_aged_1');
  });

  it('a tightened window rejects a fresh-but-outside receipt', async () => {
    const twoHoursOld = makeJws({
      bundleId: 'com.example.app', type: 'Non-Consumable', productId: 'welcome_pass',
      transactionId: 'tx_fresh_1', originalTransactionId: 'tx_fresh_1',
      purchaseDate: Date.now() - 2 * 60 * 60 * 1000, environment: 'Production',
    });
    const result = await validateAppleConsumableReceipt(twoHoursOld, {
      bundleId: 'com.example.app', skipJwsVerification: true,
      productReceiptMaxAgeHours: 1,
    });
    expect(result).toBeNull();
  });
});
