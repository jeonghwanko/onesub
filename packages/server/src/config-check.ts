import type { OneSubServerConfig } from '@onesub/shared';
import { getAppRegistry } from './apps.js';
import { log } from './logger.js';

/**
 * Startup validation of the server config.
 *
 * Everything here used to surface per request, long after deploy: a
 * `defaultAppId` typo as every unrouted request silently going to the first
 * app, an unusable `serviceAccountKey` as a failed first Android purchase. Checking once at `createOneSubMiddleware` turns
 * those into a boot failure with the reason in it.
 *
 * Errors are reserved for configs that cannot work at all. A setting that only
 * disables a feature, or that is ambiguous but deterministic — an unusable
 * Google key, Apple API credentials given partially, one bundle ID on two
 * apps — is a warning, so a harmless leftover cannot stop a working deployment
 * on upgrade.
 */
export function assertValidConfig(config: OneSubServerConfig): void {
  const errors: string[] = [];
  const warn = (message: string, appId: string) => log.warn(`[onesub] config: ${message}`, { appId });

  const registry = getAppRegistry(config);
  const seenIds = new Set<string>();
  const seenBundles = new Map<string, string>();
  const seenPackages = new Map<string, string>();

  for (const app of registry.apps) {
    const id = app.id;
    if (!id) errors.push('every apps[] entry needs a non-empty id');
    else if (seenIds.has(id)) errors.push(`app id "${id}" is used twice`);
    seenIds.add(id);

    const apple = app.apple;
    if (apple) {
      if (!apple.bundleId) errors.push(`app "${id}": apple.bundleId is empty`);
      else claimOnce(seenBundles, apple.bundleId, id, 'apple.bundleId');
      checkMaxAge(apple.productReceiptMaxAgeHours, `app "${id}": apple.productReceiptMaxAgeHours`, errors);
      const apiCreds = [apple.keyId, apple.issuerId, apple.privateKey].filter(Boolean).length;
      if (apiCreds > 0 && apiCreds < 3) {
        warn('apple keyId / issuerId / privateKey are only partly set — App Store Server API calls are disabled', id);
      }
      if (!!apple.offerKeyId !== !!apple.offerPrivateKey) {
        warn('apple offerKeyId and offerPrivateKey must be set together — promotional offer signing is disabled', id);
      }
    }

    const google = app.google;
    if (google) {
      if (google.packageName) claimOnce(seenPackages, google.packageName, id, 'google.packageName');
      // A warning, not an error: a bad key disables Google validation only, and
      // the shipped .env.example carries a placeholder an Apple-only deployment
      // may never touch. An empty string means "no key", as in the validators.
      if (google.serviceAccountKey) {
        const problem = serviceAccountKeyProblem(google.serviceAccountKey);
        if (problem) warn(`google.serviceAccountKey ${problem} — Google receipt validation will fail`, id);
      }
      checkMaxAge(google.productReceiptMaxAgeHours, `app "${id}": google.productReceiptMaxAgeHours`, errors);
    }
  }

  if (config.defaultAppId !== undefined && !seenIds.has(config.defaultAppId)) {
    errors.push(`defaultAppId "${config.defaultAppId}" names no configured app`);
  }
  if (
    config.metricsCacheTtlSeconds !== undefined &&
    !(Number.isFinite(config.metricsCacheTtlSeconds) && config.metricsCacheTtlSeconds >= 0)
  ) {
    errors.push('metricsCacheTtlSeconds must be a non-negative number');
  }
  if (config.refundPolicy !== undefined && config.refundPolicy !== 'immediate' && config.refundPolicy !== 'until_expiry') {
    errors.push(`refundPolicy must be 'immediate' or 'until_expiry'`);
  }

  if (errors.length > 0) {
    throw new Error(`[onesub] Invalid configuration:\n  - ${errors.join('\n  - ')}`);
  }
}

/**
 * Two apps answering to one bundle ID / package name resolve every receipt to
 * the first one listed. Deterministic, so a warning rather than an error — a
 * top-level app repeated under `apps` while migrating is the common case — but
 * the second app's credentials are never used for it.
 */
function claimOnce(seen: Map<string, string>, key: string, appId: string, field: string): void {
  const holder = seen.get(key);
  if (holder !== undefined && holder !== appId) {
    log.warn(`[onesub] config: ${field} is configured on two apps — the first listed wins`, { appId: holder });
  }
  if (holder === undefined) seen.set(key, appId);
}

function checkMaxAge(value: number | undefined, label: string, errors: string[]): void {
  // Infinity is allowed — it switches the age check off, for migrations. NaN
  // fails `> 0`, which matters: a NaN cutoff silently disabled the check.
  if (value !== undefined && !(value > 0)) errors.push(`${label} must be a positive number`);
}

/** Why a Google service account key cannot work, or undefined when it can. */
function serviceAccountKeyProblem(raw: string): string | undefined {
  let key: unknown;
  try {
    key = JSON.parse(raw);
  } catch {
    return 'is not valid JSON (pass the key file contents, not its path)';
  }
  const k = key as { client_email?: unknown; private_key?: unknown } | null;
  if (typeof k?.client_email !== 'string' || typeof k.private_key !== 'string') {
    return 'is missing client_email or private_key';
  }
  return undefined;
}
