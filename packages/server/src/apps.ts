import type { OneSubAppConfig, OneSubServerConfig } from '@onesub/shared';
import { log } from './logger.js';

/**
 * Resolves which app an incoming receipt belongs to, so one onesub instance can
 * serve N bundles.
 *
 * A single-app deployment configures `apple`/`google` at the top level and never
 * touches `apps` — that config stays the default and nothing here changes its
 * behaviour.
 */
export interface AppRegistry {
  readonly apps: OneSubAppConfig[];
  readonly defaultApp: OneSubAppConfig | undefined;
  /**
   * Returns the server config with `apple`/`google` swapped to the matched app's
   * credentials, so downstream providers keep reading `config.apple` /
   * `config.google` without knowing about multi-app.
   */
  configFor(hint: AppHint): OneSubServerConfig;
}

export interface AppHint {
  /** `appId` from the request body, when the client sends one. */
  appId?: string | null | undefined;
  /** Bundle id read out of an Apple receipt — the receipt names its own app. */
  bundleId?: string | null | undefined;
}

function appName(app: OneSubAppConfig): string {
  return app.id || app.apple?.bundleId || app.google?.packageName || 'default';
}

const registryCache = new WeakMap<OneSubServerConfig, AppRegistry>();

/**
 * Registry for this config, built once. Routes and webhook handlers all resolve
 * through the same instance so the multi-app summary is logged a single time.
 */
export function getAppRegistry(config: OneSubServerConfig): AppRegistry {
  const cached = registryCache.get(config);
  if (cached) return cached;
  const registry = buildAppRegistry(config);
  registryCache.set(config, registry);
  return registry;
}

export function buildAppRegistry(config: OneSubServerConfig): AppRegistry {
  const apps: OneSubAppConfig[] = [...(config.apps ?? [])];

  // The top-level apple/google config is an app in its own right. Keeping it in
  // the list means a single-app deployment resolves through the same path.
  if (config.apple || config.google) {
    const id = config.defaultAppId || config.apple?.bundleId || config.google?.packageName || 'default';
    if (!apps.some((a) => a.id === id)) {
      apps.unshift({ id, apple: config.apple, google: config.google });
    }
  }

  const defaultApp =
    apps.find((a) => a.id === config.defaultAppId) ??
    // No explicit default: fall back to the top-level config, which unshifted to
    // the front above. Never silently pick an arbitrary app when several exist —
    // that would validate one app's receipt against another's credentials.
    (config.apple || config.google || apps.length === 1 ? apps[0] : undefined);

  if (apps.length > 1) {
    log.info('[onesub] Multi-app mode:', apps.map(appName).join(', '), '| default:', defaultApp ? appName(defaultApp) : '(none)');
  }

  function match(hint: AppHint): OneSubAppConfig | undefined {
    if (hint.appId) {
      const byId = apps.find(
        (a) =>
          a.id === hint.appId ||
          a.apple?.bundleId === hint.appId ||
          a.google?.packageName === hint.appId,
      );
      if (byId) return byId;
      // An appId we don't serve must not silently fall through to the default —
      // that would validate it against some other app's credentials.
      log.warn('[onesub] Unknown appId:', hint.appId);
      return undefined;
    }

    // Apple receipts carry their own bundleId, so an Apple client needs no appId.
    if (hint.bundleId) {
      const byBundle = apps.find((a) => a.apple?.bundleId === hint.bundleId);
      if (byBundle) return byBundle;
      log.warn('[onesub] No app configured for bundleId:', hint.bundleId);
      return undefined;
    }

    return defaultApp;
  }

  return {
    apps,
    defaultApp,
    configFor(hint: AppHint): OneSubServerConfig {
      const app = match(hint);
      if (!app) {
        // Hand back a config with no providers: the route then reports the usual
        // "config missing" error rather than validating against the wrong app.
        return { ...config, apple: undefined, google: undefined };
      }
      return { ...config, apple: app.apple, google: app.google };
    },
  };
}

/**
 * Reads the bundleId out of an Apple JWS **without verifying its signature**,
 * only to decide which app's credentials to validate it with.
 *
 * Trusting this to pick the app is safe: the chosen app's validator then verifies
 * the signature against Apple's roots and re-checks the bundleId, so a forged
 * payload claiming another app's bundle fails there.
 */
export function peekAppleBundleId(jws: string): string | undefined {
  try {
    const payload = jws.split('.')[1];
    if (!payload) return undefined;
    const json = Buffer.from(payload, 'base64url').toString('utf-8');
    const claims = JSON.parse(json) as { bundleId?: string };
    return typeof claims.bundleId === 'string' ? claims.bundleId : undefined;
  } catch {
    return undefined;
  }
}
