import { describe, it, expect } from 'vitest';
import { runSetup } from '../tools/setup.js';
import { runAddPaywall } from '../tools/add-paywall.js';
import { runTroubleshoot } from '../tools/troubleshoot.js';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function getText(result: { content: Array<{ type: 'text'; text: string }> }): string {
  return result.content.map((c) => c.text).join('\n');
}

const BASE_SETUP_ARGS = {
  projectPath: '/tmp/my-app',
  productId: 'com.example.app_monthly',
  price: '$4.99/month',
};

const BASE_PAYWALL_ARGS = {
  title: 'Go Premium',
  features: ['Unlimited access', 'No ads'],
  price: '$4.99/month',
};

// ---------------------------------------------------------------------------
// setup tool
// ---------------------------------------------------------------------------

describe('onesub_setup tool', () => {
  it('uses useOneSub — not useSubscription', async () => {
    const result = await runSetup(BASE_SETUP_ARGS);
    const text = getText(result);

    expect(text).toContain('useOneSub');
    expect(text).not.toContain('useSubscription');
  });

  it('uses subscribe — not purchase(', async () => {
    const result = await runSetup(BASE_SETUP_ARGS);
    const text = getText(result);

    expect(text).toContain('subscribe');
    expect(text).not.toContain('purchase(');
  });

  it('does not contain showPaywall', async () => {
    const result = await runSetup(BASE_SETUP_ARGS);
    const text = getText(result);

    expect(text).not.toContain('showPaywall');
  });

  it('includes the productId in the output', async () => {
    const result = await runSetup(BASE_SETUP_ARGS);
    const text = getText(result);

    expect(text).toContain('com.example.app_monthly');
  });

  it('uses default server URL when serverUrl is omitted', async () => {
    const result = await runSetup(BASE_SETUP_ARGS);
    const text = getText(result);

    expect(text).toContain('http://localhost:4100');
  });

  it('uses provided serverUrl when given', async () => {
    const result = await runSetup({ ...BASE_SETUP_ARGS, serverUrl: 'https://api.example.com' });
    const text = getText(result);

    expect(text).toContain('https://api.example.com');
  });

  it('returns content array with at least one text entry', async () => {
    const result = await runSetup(BASE_SETUP_ARGS);

    expect(Array.isArray(result.content)).toBe(true);
    expect(result.content.length).toBeGreaterThan(0);
    expect(result.content[0].type).toBe('text');
    expect(typeof result.content[0].text).toBe('string');
    expect(result.content[0].text.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// add-paywall tool
// ---------------------------------------------------------------------------

describe('onesub_add_paywall tool', () => {
  describe('minimal style (default)', () => {
    it('uses useOneSub — not useSubscription', async () => {
      const result = await runAddPaywall({ ...BASE_PAYWALL_ARGS, style: 'minimal' });
      const text = getText(result);

      expect(text).toContain('useOneSub');
      expect(text).not.toContain('useSubscription');
    });

    it('uses subscribe — not purchase(', async () => {
      const result = await runAddPaywall({ ...BASE_PAYWALL_ARGS, style: 'minimal' });
      const text = getText(result);

      expect(text).toContain('subscribe');
      expect(text).not.toContain('purchase(');
    });

    it('does not contain showPaywall', async () => {
      const result = await runAddPaywall({ ...BASE_PAYWALL_ARGS, style: 'minimal' });
      const text = getText(result);

      expect(text).not.toContain('showPaywall');
    });

    it('includes all provided features', async () => {
      const result = await runAddPaywall({ ...BASE_PAYWALL_ARGS, style: 'minimal' });
      const text = getText(result);

      expect(text).toContain('Unlimited access');
      expect(text).toContain('No ads');
    });
  });

  describe('gradient style', () => {
    it('uses useOneSub — not useSubscription', async () => {
      const result = await runAddPaywall({ ...BASE_PAYWALL_ARGS, style: 'gradient' });
      const text = getText(result);

      expect(text).toContain('useOneSub');
      expect(text).not.toContain('useSubscription');
    });

    it('uses subscribe — not purchase(', async () => {
      const result = await runAddPaywall({ ...BASE_PAYWALL_ARGS, style: 'gradient' });
      const text = getText(result);

      expect(text).toContain('subscribe');
      expect(text).not.toContain('purchase(');
    });

    it('does not contain showPaywall', async () => {
      const result = await runAddPaywall({ ...BASE_PAYWALL_ARGS, style: 'gradient' });
      const text = getText(result);

      expect(text).not.toContain('showPaywall');
    });

    it('mentions expo-linear-gradient dependency', async () => {
      const result = await runAddPaywall({ ...BASE_PAYWALL_ARGS, style: 'gradient' });
      const text = getText(result);

      expect(text).toContain('expo-linear-gradient');
    });
  });

  describe('card style', () => {
    it('uses useOneSub — not useSubscription', async () => {
      const result = await runAddPaywall({ ...BASE_PAYWALL_ARGS, style: 'card' });
      const text = getText(result);

      expect(text).toContain('useOneSub');
      expect(text).not.toContain('useSubscription');
    });

    it('uses subscribe — not purchase(', async () => {
      const result = await runAddPaywall({ ...BASE_PAYWALL_ARGS, style: 'card' });
      const text = getText(result);

      expect(text).toContain('subscribe');
      expect(text).not.toContain('purchase(');
    });

    it('does not contain showPaywall', async () => {
      const result = await runAddPaywall({ ...BASE_PAYWALL_ARGS, style: 'card' });
      const text = getText(result);

      expect(text).not.toContain('showPaywall');
    });
  });
});

// ---------------------------------------------------------------------------
// troubleshoot tool
// ---------------------------------------------------------------------------

describe('onesub_troubleshoot tool', () => {
  it('does not suggest refresh() as a method call', async () => {
    const result = await runTroubleshoot({
      issue: 'Paywall showing for subscribed user',
      platform: 'both',
    });
    const text = getText(result);

    // refresh() is NOT the onesub API — the correct method is restore()
    expect(text).not.toContain('refresh()');
  });

  it('suggests restore() from useOneSub when subscription status is stale', async () => {
    const result = await runTroubleshoot({
      issue: 'Paywall showing for subscribed user',
      platform: 'both',
    });
    const text = getText(result);

    expect(text).toContain('restore()');
  });

  it('suggests restore() from useOneSub for restore-not-working issues', async () => {
    const result = await runTroubleshoot({
      issue: 'restore purchases not working',
      platform: 'ios',
    });
    const text = getText(result);

    expect(text).toContain('restore()');
    expect(text).not.toContain('refresh()');
  });

  it('returns content array with at least one text entry', async () => {
    const result = await runTroubleshoot({ issue: 'purchase failed', platform: 'ios' });

    expect(Array.isArray(result.content)).toBe(true);
    expect(result.content.length).toBeGreaterThan(0);
    expect(result.content[0].type).toBe('text');
  });

  it('diagnoses receipt validation issues for iOS', async () => {
    const result = await runTroubleshoot({
      issue: 'receipt validation failed',
      platform: 'ios',
      logs: 'Error 21007: receipt from sandbox',
    });
    const text = getText(result);

    expect(text).toContain('21007');
  });
});
