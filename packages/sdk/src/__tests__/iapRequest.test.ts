import { describe, expect, it, vi } from 'vitest';
import { buildRequestPurchaseArgs } from '../iapRequest.js';

describe('buildRequestPurchaseArgs', () => {
  it('passes Android subscription offer tokens returned by the store', () => {
    const args = buildRequestPurchaseArgs(
      'premium.monthly',
      'android',
      'subs',
      'account-123',
      {
        subscriptionOffers: [{ offerTokenAndroid: 'standard-token' }],
        subscriptionOfferDetailsAndroid: [
          { offerToken: 'legacy-token' },
          { offerToken: 'standard-token' },
        ],
      },
    );

    expect(args).toEqual({
      request: {
        android: {
          skus: ['premium.monthly'],
          subscriptionOffers: [
            { sku: 'premium.monthly', offerToken: 'standard-token' },
            { sku: 'premium.monthly', offerToken: 'legacy-token' },
          ],
          obfuscatedAccountId: 'account-123',
        },
      },
      type: 'subs',
    });
  });

  it('keeps iOS subscription requests platform-scoped', () => {
    expect(
      buildRequestPurchaseArgs(
        'premium.monthly',
        'ios',
        'subs',
        '123e4567-e89b-12d3-a456-426614174000',
      ),
    ).toEqual({
      request: {
        ios: {
          sku: 'premium.monthly',
          appAccountToken: '123e4567-e89b-12d3-a456-426614174000',
        },
      },
      type: 'subs',
    });
  });

  it('omits an invalid iOS account token without changing checkout args', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(buildRequestPurchaseArgs('premium.monthly', 'ios', 'subs', 'not-a-uuid')).toEqual({
      request: { ios: { sku: 'premium.monthly' } },
      type: 'subs',
    });
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});
