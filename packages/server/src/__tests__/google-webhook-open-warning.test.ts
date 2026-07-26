/**
 * Startup warnings for the Google RTDN route's two loose conditions.
 *
 * The authentication half changed in 0.27.0: without a `pushAudience` the route used
 * to accept the request, and now refuses it with 401 in production unless
 * `google.allowUnauthenticatedWebhook` says otherwise. So there are two warnings to
 * tell apart, and getting them backwards would be worse than having none — an
 * operator reading "insecure" when the endpoint is actually refusing traffic goes
 * hunting for a breach instead of a missing config value.
 *
 * Open mode (no `packageName`) is unchanged: it still warns rather than refusing.
 *
 * The assertions here were rewritten, not adjusted. Three of them were negative
 * matches against the old warning's wording — text this file no longer produces at
 * all, so they would have passed however loudly the new warning fired. A negative
 * assertion against a string that cannot occur is not coverage, so each one now
 * names both current warnings explicitly.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { OneSubLogger, OneSubServerConfig } from '@onesub/shared';
import { createOneSubMiddleware } from '../index.js';
import { InMemorySubscriptionStore, InMemoryPurchaseStore } from '../store.js';

/** Captures what the configured logger was told. */
function recordingLogger() {
  const warns: string[] = [];
  const logger: OneSubLogger = {
    info: () => {},
    warn: (...args: unknown[]) => {
      warns.push(args.map(String).join(' '));
    },
    error: () => {},
  };
  return { logger, warns, joined: () => warns.join('\n') };
}

function build(config: Partial<OneSubServerConfig>, logger: OneSubLogger) {
  createOneSubMiddleware({
    database: { url: '' },
    logger,
    store: new InMemorySubscriptionStore(),
    purchaseStore: new InMemoryPurchaseStore(),
    ...config,
  });
}

const originalNodeEnv = process.env['NODE_ENV'];

beforeEach(() => {
  process.env['NODE_ENV'] = 'production';
});

afterEach(() => {
  if (originalNodeEnv === undefined) delete process.env['NODE_ENV'];
  else process.env['NODE_ENV'] = originalNodeEnv;
  vi.restoreAllMocks();
});

/** Text unique to each of the two warnings, so a test cannot match the wrong one. */
const WILL_REJECT = 'will reject every request with 401';
const OPTED_IN = 'runs unauthenticated by explicit opt-in';

describe('unauthenticated Google webhook', () => {
  it('says the route will refuse traffic when no pushAudience is set', () => {
    const { logger, joined } = recordingLogger();
    build({ google: { packageName: 'com.example.app', serviceAccountKey: '{}' } }, logger);

    expect(joined()).toContain(WILL_REJECT);
    expect(joined()).toContain('google.pushAudience');
    // It must also offer the escape hatch, or an operator who genuinely
    // authenticates upstream has been told to do something they cannot do.
    expect(joined()).toContain('google.allowUnauthenticatedWebhook');
    expect(joined()).not.toContain(OPTED_IN);
  });

  it('warns differently, and names the consequence, when the host opts in', () => {
    // Opting in is legitimate behind Cloud Run IAM or mTLS, so this is not an
    // error — but it prints every boot, because during an incident nobody should
    // have to go and read the config to learn this endpoint trusts its caller.
    const { logger, joined } = recordingLogger();
    build(
      {
        google: {
          packageName: 'com.example.app',
          serviceAccountKey: '{}',
          allowUnauthenticatedWebhook: true,
        },
      },
      logger,
    );

    expect(joined()).toContain(OPTED_IN);
    expect(joined()).toMatch(/cancel a subscription or delete a one-time purchase/);
    expect(joined()).not.toContain(WILL_REJECT);
  });

  it('stays quiet once pushAudience is configured', () => {
    const { logger, joined } = recordingLogger();
    build(
      {
        google: {
          packageName: 'com.example.app',
          serviceAccountKey: '{}',
          pushAudience: 'https://api.example.com/onesub/webhook/google',
        },
      },
      logger,
    );

    expect(joined()).not.toContain(WILL_REJECT);
    expect(joined()).not.toContain(OPTED_IN);
  });

  it('is satisfied when any app in a multi-app config sets pushAudience', () => {
    const { logger, joined } = recordingLogger();
    build(
      {
        apps: [
          {
            id: 'a',
            google: {
              packageName: 'com.example.a',
              pushAudience: 'https://api.example.com/onesub/webhook/google',
            },
          },
          { id: 'b', google: { packageName: 'com.example.b' } },
        ],
      },
      logger,
    );

    // One shared push endpoint across apps is the documented topology, so this
    // must not nag when it is set on the app that actually receives the push.
    expect(joined()).not.toContain(WILL_REJECT);
    expect(joined()).not.toContain(OPTED_IN);
  });

  it('does not warn about authentication when Google is not configured at all', () => {
    // Nothing to authenticate against; the open-mode warning covers the fact
    // that the route is mounted regardless.
    const { logger, joined } = recordingLogger();
    build({ apple: { bundleId: 'com.example.app' } }, logger);

    expect(joined()).not.toContain(WILL_REJECT);
    expect(joined()).not.toContain(OPTED_IN);
  });
});

describe('open mode (no packageName declared)', () => {
  it('says nothing for an Apple-only deployment, which does not mount the route', () => {
    // The route is no longer mounted without a Google config, so there is no
    // open-mode exposure to report. `webhook-google-mount.test.ts` asserts the
    // mounting side of this; here the point is that the two agree.
    const { logger, warns } = recordingLogger();
    build({ apple: { bundleId: 'com.example.app' } }, logger);

    expect(warns).toEqual([]);
  });

  it('warns when google is configured without a packageName', () => {
    const { logger, joined } = recordingLogger();
    build({ google: { serviceAccountKey: '{}' } as OneSubServerConfig['google'] }, logger);
    expect(joined()).toContain('open mode');
  });

  it('stays quiet once a packageName is declared', () => {
    const { logger, joined } = recordingLogger();
    build(
      {
        google: {
          packageName: 'com.example.app',
          serviceAccountKey: '{}',
          pushAudience: 'https://api.example.com/onesub/webhook/google',
        },
      },
      logger,
    );

    expect(joined()).not.toContain('open mode');
  });
});

describe('outside production', () => {
  it('says nothing, so it cannot drown itself out in dev and tests', () => {
    // A missing pushAudience is normal locally — no real RTDN arrives — and an
    // unconditional warning would fire on nearly every test in this repo.
    delete process.env['NODE_ENV'];
    const { logger, warns } = recordingLogger();
    build({ apple: { bundleId: 'com.example.app' } }, logger);
    expect(warns).toEqual([]);

    process.env['NODE_ENV'] = 'development';
    const dev = recordingLogger();
    build({ google: { packageName: 'com.example.app' } }, dev.logger);
    expect(dev.warns).toEqual([]);
  });
});
