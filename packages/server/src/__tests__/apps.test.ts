import { describe, it, expect } from 'vitest';
import type { OneSubServerConfig } from '@onesub/shared';
import { buildAppRegistry, peekAppleBundleId } from '../apps.js';

const COFFEE = {
  apple: { bundleId: 'gg.pryzm.coffee' },
  google: { packageName: 'gg.pryzm.coffee', serviceAccountKey: 'coffee-sa' },
};
const PENGUIN = {
  apple: { bundleId: 'gg.pryzm.penguinrun' },
  google: { packageName: 'gg.pryzm.penguinrun', serviceAccountKey: 'penguin-sa' },
};

function multiApp(): OneSubServerConfig {
  return {
    database: { url: '' },
    apps: [
      { id: 'coffee', ...COFFEE },
      { id: 'penguinrun', ...PENGUIN },
    ],
    defaultAppId: 'coffee',
  };
}

/** Apple JWS shape: header.payload.signature, payload base64url-encoded. */
function jwsWithBundleId(bundleId: string): string {
  const payload = Buffer.from(JSON.stringify({ bundleId })).toString('base64url');
  return `eyJhbGciOiJFUzI1NiJ9.${payload}.sig`;
}

describe('peekAppleBundleId', () => {
  it('reads the bundleId out of a JWS payload', () => {
    expect(peekAppleBundleId(jwsWithBundleId('gg.pryzm.penguinrun'))).toBe('gg.pryzm.penguinrun');
  });

  it('returns undefined for a non-JWS receipt (Google purchase token)', () => {
    expect(peekAppleBundleId('abcdefgh.AO-J1O...')).toBeUndefined();
    expect(peekAppleBundleId('')).toBeUndefined();
  });
});

describe('app registry — single-app (backward compatible)', () => {
  it('treats the top-level apple/google config as the default app', () => {
    const registry = buildAppRegistry({ database: { url: '' }, ...COFFEE });

    // A request that names no app still resolves to the one configured app —
    // this is the deployed coffee client, which sends no appId.
    const resolved = registry.configFor({});
    expect(resolved.apple?.bundleId).toBe('gg.pryzm.coffee');
    expect(resolved.google?.packageName).toBe('gg.pryzm.coffee');
  });
});

describe('app registry — multi-app', () => {
  it('resolves an Apple receipt by the bundleId baked into it, with no appId', () => {
    const registry = buildAppRegistry(multiApp());

    const bundleId = peekAppleBundleId(jwsWithBundleId('gg.pryzm.penguinrun'));
    const resolved = registry.configFor({ bundleId });

    expect(resolved.apple?.bundleId).toBe('gg.pryzm.penguinrun');
    expect(resolved.google?.serviceAccountKey).toBe('penguin-sa');
  });

  it('resolves by appId — id, Apple bundleId, or Google packageName all match', () => {
    const registry = buildAppRegistry(multiApp());

    for (const appId of ['penguinrun', 'gg.pryzm.penguinrun']) {
      const resolved = registry.configFor({ appId });
      expect(resolved.google?.serviceAccountKey).toBe('penguin-sa');
    }
  });

  it('falls back to the default app when the request names none', () => {
    const registry = buildAppRegistry(multiApp());

    // Google purchase tokens carry no package, so a client that sends no appId
    // lands on the default — which is what keeps the deployed coffee build working.
    const resolved = registry.configFor({});
    expect(resolved.google?.serviceAccountKey).toBe('coffee-sa');
  });

  it('serves no provider for an unknown appId rather than falling back', () => {
    const registry = buildAppRegistry(multiApp());

    // Falling back to the default here would validate an unknown app's receipt
    // against coffee's credentials.
    const resolved = registry.configFor({ appId: 'com.attacker.app' });
    expect(resolved.apple).toBeUndefined();
    expect(resolved.google).toBeUndefined();
  });

  it('serves no provider for an Apple receipt from an app it does not host', () => {
    const registry = buildAppRegistry(multiApp());

    const bundleId = peekAppleBundleId(jwsWithBundleId('com.attacker.app'));
    const resolved = registry.configFor({ bundleId });
    expect(resolved.apple).toBeUndefined();
  });

  it('keeps each app on its own credentials', () => {
    const registry = buildAppRegistry(multiApp());

    expect(registry.configFor({ appId: 'coffee' }).google?.serviceAccountKey).toBe('coffee-sa');
    expect(registry.configFor({ appId: 'penguinrun' }).google?.serviceAccountKey).toBe('penguin-sa');
  });

  it('does not pick an arbitrary app as default when none is named', () => {
    // apps[] with no defaultAppId and no top-level config: a Google request that
    // names no app is ambiguous, and guessing would cross-validate.
    const registry = buildAppRegistry({
      database: { url: '' },
      apps: [
        { id: 'coffee', ...COFFEE },
        { id: 'penguinrun', ...PENGUIN },
      ],
    });

    expect(registry.defaultApp).toBeUndefined();
    expect(registry.configFor({}).google).toBeUndefined();
  });
});
