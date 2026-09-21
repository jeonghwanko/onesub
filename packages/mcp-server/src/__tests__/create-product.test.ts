import { describe, it, expect, vi } from 'vitest';
import { createAppleSubscription, createGoogleSubscription } from '@onesub/providers';
import { runCreateProduct } from '../tools/create-product.js';

vi.mock('@onesub/providers', () => ({ createAppleSubscription: vi.fn(), createGoogleSubscription: vi.fn() }));

describe('product creation partial outcomes', () => {
  it('does not report full configuration after an Apple price error', async () => {
    vi.mocked(createAppleSubscription).mockResolvedValue({ success: true, productId: 'pro', internalId: 'sub1', priceSet: false, priceError: 'availability failed' });
    const out = await runCreateProduct({ platform: 'apple', productId: 'pro', name: 'Pro', price: 499,
      appleAppId: 'example-app', appleKeyId: 'example-key', appleIssuerId: 'example-issuer', applePrivateKey: 'example-key-material' });
    expect(out.content[0].text).toContain('availability failed');
    expect(out.content[0].text).toContain('do not repeat creation');
    expect(out.content[0].text).not.toContain('All platforms configured successfully');
  });

  it('shows a Google activation failure and the durable product ID', async () => {
    vi.mocked(createGoogleSubscription).mockResolvedValue({ success: true, productId: 'pro', active: false, activationError: 'activation refused' });
    const out = await runCreateProduct({ platform: 'google', productId: 'pro', name: 'Pro', price: 499,
      googlePackageName: 'com.example.app', googleServiceAccountKey: '{}' });
    expect(out.content[0].text).toContain('activation refused');
    expect(out.content[0].text).toContain('`pro`');
    expect(out.content[0].text).toContain('do not repeat creation');
    expect(out.content[0].text).not.toContain('All platforms configured successfully');
  });
});
