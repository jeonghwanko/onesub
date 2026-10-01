import { describe, it, expect } from 'vitest';
import type { OneSubLogger, OneSubServerConfig } from '@onesub/shared';
import { createOneSubMiddleware } from '../index.js';
import { InMemorySubscriptionStore, InMemoryPurchaseStore } from '../store.js';
import { FAKE_SERVICE_ACCOUNT_KEY } from './test-utils.js';

function build(config: Partial<OneSubServerConfig>, logger?: OneSubLogger) {
  return createOneSubMiddleware({
    database: { url: '' },
    store: new InMemorySubscriptionStore(),
    purchaseStore: new InMemoryPurchaseStore(),
    ...(logger ? { logger } : {}),
    ...config,
  });
}

function capturingLogger(): { logger: OneSubLogger; warnings: string[] } {
  const warnings: string[] = [];
  return {
    warnings,
    logger: { info: () => {}, warn: (...args: unknown[]) => { warnings.push(String(args[0])); }, error: () => {} },
  };
}

describe('startup config validation', () => {
  it('accepts a well-formed single-app and multi-app config', () => {
    expect(() => build({
      apple: { bundleId: 'com.a' },
      google: { packageName: 'com.a', serviceAccountKey: FAKE_SERVICE_ACCOUNT_KEY },
    })).not.toThrow();
    expect(() => build({
      apps: [
        { id: 'a', apple: { bundleId: 'com.a' } },
        { id: 'b', google: { packageName: 'com.b', serviceAccountKey: FAKE_SERVICE_ACCOUNT_KEY } },
      ],
      defaultAppId: 'a',
    })).not.toThrow();
  });

  it('warns, without refusing to boot, when a serviceAccountKey is not a usable key', () => {
    // A bad key disables Google only; the shipped .env.example has a placeholder.
    const { logger, warnings } = capturingLogger();
    expect(() => build({ google: { packageName: 'com.a', serviceAccountKey: '/secrets/key.json' } }, logger)).not.toThrow();
    expect(() => build({ google: { packageName: 'com.b', serviceAccountKey: '{"type":"service_account","project_id":"..."}' } }, logger)).not.toThrow();
    expect(warnings.some((w) => w.includes('is not valid JSON'))).toBe(true);
    expect(warnings.some((w) => w.includes('missing client_email or private_key'))).toBe(true);
    // Never the key's contents.
    expect(warnings.join('\n')).not.toContain('project_id');
  });

  it('treats an empty serviceAccountKey as unset, like the validators do', () => {
    expect(() => build({ google: { packageName: 'com.a', serviceAccountKey: '' } })).not.toThrow();
  });

  it('refuses a defaultAppId that names no app, which would silently route to the first one', () => {
    expect(() => build({
      apps: [{ id: 'a', apple: { bundleId: 'com.a' } }, { id: 'b', apple: { bundleId: 'com.b' } }],
      defaultAppId: 'typo',
    })).toThrow(/defaultAppId "typo" names no configured app/);
  });

  it('refuses nonsensical numbers, listing every problem at once', () => {
    let message = '';
    try {
      build({
        apps: [{ id: 'a', apple: { bundleId: 'com.a', productReceiptMaxAgeHours: 0 } }],
        metricsCacheTtlSeconds: -1,
      });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/productReceiptMaxAgeHours must be a positive number/);
    expect(message).toMatch(/metricsCacheTtlSeconds must be a non-negative number/);
  });

  it('only warns for an app id listed twice (e.g. appended twice to an env list), so the host still boots', () => {
    const { logger, warnings } = capturingLogger();
    expect(() => build({
      apps: [
        { id: 'weather', apple: { bundleId: 'com.w' } },
        { id: 'weather', apple: { bundleId: 'com.w' } },
      ],
    }, logger)).not.toThrow();
    expect(warnings.some((w) => w.includes('listed twice'))).toBe(true);
  });

  it('allows Infinity for productReceiptMaxAgeHours (the age check switched off) but not NaN', () => {
    expect(() => build({ apple: { bundleId: 'com.a', productReceiptMaxAgeHours: Infinity } })).not.toThrow();
    expect(() => build({ apple: { bundleId: 'com.a', productReceiptMaxAgeHours: Number.NaN } })).toThrow(/productReceiptMaxAgeHours/);
  });

  it('only warns for a setting that disables a feature or is ambiguous but deterministic', () => {
    const { logger, warnings } = capturingLogger();
    expect(() => build({
      apple: { bundleId: 'com.a', keyId: 'K' },
      apps: [{ id: 'main', apple: { bundleId: 'com.a' } }],
    }, logger)).not.toThrow();
    expect(warnings.some((w) => w.includes('only partly set'))).toBe(true);
    expect(warnings.some((w) => w.includes('configured on two apps'))).toBe(true);
  });
});
