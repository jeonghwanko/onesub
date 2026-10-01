import { describe, it, expect, vi, beforeEach } from 'vitest';
import { deleteAppleProduct, deleteGoogleProduct, createGoogleSubscription } from '@onesub/providers';
import { runManageProduct } from '../tools/manage-product.js';
import { runCreateProduct } from '../tools/create-product.js';

vi.mock('@onesub/providers', () => ({
  updateAppleProduct: vi.fn(),
  deleteAppleProduct: vi.fn(),
  updateGoogleProduct: vi.fn(),
  deleteGoogleProduct: vi.fn(),
  createAppleSubscription: vi.fn(),
  createGoogleSubscription: vi.fn(),
}));

const appleCreds = {
  appleKeyId: 'example-key',
  appleIssuerId: 'example-issuer',
  applePrivateKey: 'example-key-material',
  appleAppId: '123',
};
const googleCreds = { googlePackageName: 'com.example.app', googleServiceAccountKey: '{}' };

beforeEach(() => {
  vi.mocked(deleteAppleProduct).mockReset();
  vi.mocked(deleteGoogleProduct).mockReset();
});

describe('onesub_manage_product delete', () => {
  it('does not delete without confirm: true, and says so', async () => {
    const out = await runManageProduct({
      action: 'delete', platform: 'both', productId: 'pro', productType: 'subscription',
      ...appleCreds, ...googleCreds,
    });
    expect(deleteAppleProduct).not.toHaveBeenCalled();
    expect(deleteGoogleProduct).not.toHaveBeenCalled();
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toContain('Not deleted');
    expect(out.content[0].text).toContain('confirm: true');
  });

  it('deletes once confirmed, and reports success without isError', async () => {
    vi.mocked(deleteGoogleProduct).mockResolvedValue({ success: true });
    const out = await runManageProduct({
      action: 'delete', platform: 'google', productId: 'pro', productType: 'consumable',
      ...googleCreds, confirm: true,
    });
    expect(deleteGoogleProduct).toHaveBeenCalledOnce();
    expect(out.isError).toBeUndefined();
  });

  it('flags a failed store call as isError', async () => {
    vi.mocked(deleteGoogleProduct).mockResolvedValue({ success: false, error: 'forbidden' });
    const out = await runManageProduct({
      action: 'delete', platform: 'google', productId: 'pro', productType: 'consumable',
      ...googleCreds, confirm: true,
    });
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toContain('forbidden');
  });

  it('flags missing credentials as isError', async () => {
    const out = await runManageProduct({
      action: 'update', platform: 'apple', productId: 'pro', productType: 'subscription', name: 'Pro',
    });
    expect(out.isError).toBe(true);
  });
});

describe('onesub_create_product errors', () => {
  it('flags a failed create as isError', async () => {
    vi.mocked(createGoogleSubscription).mockResolvedValue({ success: false, error: 'quota' });
    const out = await runCreateProduct({
      platform: 'google', productId: 'pro', name: 'Pro', price: 499, ...googleCreds,
    });
    expect(out.isError).toBe(true);
  });

  it('leaves isError unset on success', async () => {
    vi.mocked(createGoogleSubscription).mockResolvedValue({ success: true, productId: 'pro', active: true });
    const out = await runCreateProduct({
      platform: 'google', productId: 'pro', name: 'Pro', price: 499, ...googleCreds,
    });
    expect(out.isError).toBeUndefined();
  });
});
