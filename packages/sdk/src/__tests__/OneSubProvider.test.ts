// @vitest-environment jsdom
/**
 * OneSubProvider — mount, context, and re-render behaviour.
 *
 * This package had no render test at all: `purchaseFlow.test.ts` covers the pure
 * decision logic, which is exactly why that logic was split out, but nothing
 * exercised the React half. So the provider's mount sequence, its context
 * contract, and the `null`-vs-throw semantics that host apps depend on were
 * verified only by reading them — and the referential-stability work in 0.10.4
 * shipped that way too.
 *
 * `react-native-iap` is deliberately NOT installed here, which is a supported
 * configuration rather than a gap: the provider must still import, render, and
 * report a clear error from the purchase paths. It also keeps `react-native`
 * itself out of the picture, since `getCurrentPlatform()` is only reached once an
 * IAP adapter exists.
 *
 * Written with `createElement` rather than JSX so the file is a `.test.ts` and is
 * picked up by the repository's existing Vitest include pattern.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { OneSubConfig, StatusResponse } from '@onesub/shared';
import { ONESUB_ERROR_CODE } from '@onesub/shared';
import { OneSubProvider, useOneSubContext, type OneSubContextValue } from '../OneSubProvider.js';
import { OneSubError } from '../OneSubError.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

// React refuses to let `act()` flush updates without this, and instead logs
// "not configured to support act(...)" — which would otherwise be the only thing
// the unmount test's console.error assertion ever caught.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SERVER = 'https://api.example.test';

interface ServerState {
  status: StatusResponse;
  entitlements: Record<string, { active: boolean; source: string | null }>;
  statusFails: boolean;
}

let server: ServerState;
let container: HTMLDivElement;
let root: Root;

/** Records every context value this component was rendered with. */
interface Probe {
  renders: OneSubContextValue[];
  latest: () => OneSubContextValue;
  count: () => number;
}

function makeProbe(): { probe: Probe; element: ReactNode } {
  const renders: OneSubContextValue[] = [];
  function Consumer() {
    const ctx = useOneSubContext();
    renders.push(ctx);
    return null;
  }
  return {
    probe: {
      renders,
      latest: () => renders[renders.length - 1]!,
      count: () => renders.length,
    },
    element: createElement(Consumer),
  };
}

function baseConfig(overrides?: Partial<OneSubConfig>): OneSubConfig {
  return { serverUrl: SERVER, productId: 'pro_monthly', ...overrides };
}

/** Mount the provider and flush the mount effects. */
async function mount(config: OneSubConfig, userId = 'alice', children: ReactNode = null) {
  await act(async () => {
    // `children` is required on OneSubProviderProps, so it goes in the props
    // object rather than as a positional argument.
    root.render(createElement(OneSubProvider, { config, userId, children }));
  });
}

/** Re-render with new props, flushing effects. */
async function rerender(config: OneSubConfig, userId = 'alice', children: ReactNode = null) {
  await act(async () => {
    root.render(createElement(OneSubProvider, { config, userId, children }));
  });
}

beforeEach(() => {
  server = {
    status: { active: false, subscription: null },
    entitlements: {},
    statusFails: false,
  };

  vi.stubGlobal('fetch', async (input: string | URL) => {
    const url = String(input);
    if (url.includes('/onesub/status')) {
      if (server.statusFails) throw new Error('network down');
      return new Response(JSON.stringify(server.status), { status: 200 });
    }
    if (url.includes('/onesub/entitlements')) {
      return new Response(JSON.stringify({ entitlements: server.entitlements }), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  });

  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------

describe('mount', () => {
  it('renders its children', async () => {
    await mount(baseConfig(), 'alice', createElement('span', { id: 'child' }, 'hello'));
    expect(container.querySelector('#child')?.textContent).toBe('hello');
  });

  it('adopts the subscription state the server reports', async () => {
    server.status = {
      active: true,
      subscription: {
        userId: 'alice',
        productId: 'pro_monthly',
        platform: 'apple',
        status: 'active',
        expiresAt: '2099-01-01T00:00:00.000Z',
        purchasedAt: '2026-01-01T00:00:00.000Z',
        originalTransactionId: 'tx-1',
        willRenew: true,
      },
    };
    const { probe, element } = makeProbe();
    await mount(baseConfig(), 'alice', element);

    expect(probe.latest().isActive).toBe(true);
    expect(probe.latest().subscription?.originalTransactionId).toBe('tx-1');
    expect(probe.latest().isLoading).toBe(false);
  });

  it('loads the entitlements map', async () => {
    server.entitlements = { premium: { active: true, source: 'subscription' } };
    const { probe, element } = makeProbe();
    await mount(baseConfig(), 'alice', element);

    expect(probe.latest().entitlements.premium?.active).toBe(true);
    expect(probe.latest().hasEntitlement('premium')).toBe(true);
    expect(probe.latest().hasEntitlement('nope')).toBe(false);
  });

  it('survives a status request that fails, reporting not-active', async () => {
    // A host must still get a usable provider when the server is unreachable —
    // the alternative is an unhandled rejection at app launch.
    server.statusFails = true;
    const { probe, element } = makeProbe();
    await mount(baseConfig(), 'alice', element);

    expect(probe.latest().isActive).toBe(false);
    expect(probe.latest().subscription).toBeNull();
    expect(probe.latest().isLoading).toBe(false);
  });

  it('exposes the whole documented context surface', async () => {
    const { probe, element } = makeProbe();
    await mount(baseConfig(), 'alice', element);

    const ctx = probe.latest();
    for (const key of [
      'subscribe',
      'subscribeWithResult',
      'restore',
      'purchaseProduct',
      'restoreProduct',
      'refreshEntitlements',
      'hasEntitlement',
    ] as const) {
      expect(typeof ctx[key]).toBe('function');
    }
    expect(ctx.isBusy).toBe(false);
  });
});

describe('useOneSub outside a provider', () => {
  it('throws NOT_IN_PROVIDER rather than returning undefined', async () => {
    const { element } = makeProbe();
    let caught: unknown;
    // React logs the error boundary miss; swallow it to keep output readable.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await act(async () => {
        root.render(element);
      });
    } catch (err) {
      caught = err;
    } finally {
      spy.mockRestore();
    }
    expect(caught).toBeInstanceOf(OneSubError);
    expect((caught as OneSubError).code).toBe(ONESUB_ERROR_CODE.NOT_IN_PROVIDER);
  });
});

describe('context identity (0.10.4 memoization)', () => {
  it('does not hand consumers a new context on a parent re-render', async () => {
    // The regression this guards: the value object was rebuilt every render and
    // the callbacks depended on the whole `config` object, so a host passing an
    // inline literal re-rendered every useOneSub() consumer on any parent render.
    const { probe, element } = makeProbe();
    await mount(baseConfig(), 'alice', element);
    const before = probe.count();
    const identity = probe.latest();

    // A fresh config object each time, exactly as `config={{ ... }}` produces.
    await rerender(baseConfig(), 'alice', element);
    await rerender(baseConfig(), 'alice', element);
    await rerender(baseConfig(), 'alice', element);

    expect(probe.latest()).toBe(identity);
    // Re-renders of the consumer itself are React's business; what must not
    // happen is the context value changing identity.
    expect(probe.renders.slice(before).every((c) => c === identity)).toBe(true);
  });

  it('keeps the purchase callbacks referentially stable across those renders', async () => {
    const { probe, element } = makeProbe();
    await mount(baseConfig(), 'alice', element);
    const first = probe.latest();

    await rerender(baseConfig(), 'alice', element);

    expect(probe.latest().subscribe).toBe(first.subscribe);
    expect(probe.latest().purchaseProduct).toBe(first.purchaseProduct);
    expect(probe.latest().restoreProduct).toBe(first.restoreProduct);
    expect(probe.latest().restore).toBe(first.restore);
    expect(probe.latest().refreshEntitlements).toBe(first.refreshEntitlements);
  });

  it('DOES give a new context when the state it carries changes', async () => {
    // Stability must not be achieved by freezing: a state change has to
    // propagate, or consumers would never see a purchase land.
    server.entitlements = {};
    const { probe, element } = makeProbe();
    await mount(baseConfig(), 'alice', element);
    const before = probe.latest();

    server.entitlements = { premium: { active: true, source: 'subscription' } };
    await act(async () => {
      await before.refreshEntitlements();
    });

    expect(probe.latest()).not.toBe(before);
    expect(probe.latest().entitlements.premium?.active).toBe(true);
  });
});

describe('config read through a ref (0.10.4 staleness fix)', () => {
  it('a callback sees a config field changed after mount', async () => {
    // The latent bug: the mount effect re-runs only on serverUrl/userId, so a
    // callback that closed over `config` kept the value from mount. Here the
    // productId changes without either of those changing, and mockMode's
    // synthetic subscription reports which productId the callback actually used.
    const { probe, element } = makeProbe();
    await mount(baseConfig({ mockMode: true, productId: 'first' }), 'alice', element);

    await rerender(baseConfig({ mockMode: true, productId: 'second' }), 'alice', element);

    await act(async () => {
      await probe.latest().subscribe();
    });

    expect(probe.latest().subscription?.productId).toBe('second');
  });

  it('uses the platform-specific product id when one is given', async () => {
    const { probe, element } = makeProbe();
    await mount(
      baseConfig({ mockMode: true, productId: 'generic', appleProductId: 'apple_only' }),
      'alice',
      element,
    );

    await act(async () => {
      await probe.latest().subscribe();
    });

    expect(probe.latest().subscription?.productId).toBe('apple_only');
  });
});

describe('without react-native-iap installed', () => {
  it('subscribe rejects with RN_IAP_NOT_INSTALLED', async () => {
    const { probe, element } = makeProbe();
    await mount(baseConfig(), 'alice', element);

    await expect(probe.latest().subscribe()).rejects.toMatchObject({
      code: ONESUB_ERROR_CODE.RN_IAP_NOT_INSTALLED,
    });
  });

  it('purchaseProduct and restoreProduct reject the same way', async () => {
    const { probe, element } = makeProbe();
    await mount(baseConfig(), 'alice', element);

    await expect(probe.latest().purchaseProduct('coins', 'consumable')).rejects.toMatchObject({
      code: ONESUB_ERROR_CODE.RN_IAP_NOT_INSTALLED,
    });
    await expect(
      probe.latest().restoreProduct('lifetime', 'non_consumable'),
    ).rejects.toMatchObject({ code: ONESUB_ERROR_CODE.RN_IAP_NOT_INSTALLED });
  });

  it('releases the busy lock after a rejection, so the next attempt is not blocked', async () => {
    // If the failure path left isBusy set, every later call would return null
    // and look like a silent cancel.
    const { probe, element } = makeProbe();
    await mount(baseConfig(), 'alice', element);

    await expect(probe.latest().subscribe()).rejects.toThrow();
    expect(probe.latest().isBusy).toBe(false);
    await expect(probe.latest().subscribe()).rejects.toThrow();
  });
});

describe('mockMode', () => {
  it('reports an active subscription without contacting a store', async () => {
    const { probe, element } = makeProbe();
    await mount(baseConfig({ mockMode: true }), 'alice', element);

    await act(async () => {
      await probe.latest().subscribe();
    });

    expect(probe.latest().isActive).toBe(true);
  });

  it('returns a synthetic purchase from purchaseProduct', async () => {
    const { probe, element } = makeProbe();
    await mount(baseConfig({ mockMode: true }), 'alice', element);

    let result: Awaited<ReturnType<OneSubContextValue['purchaseProduct']>> = null;
    await act(async () => {
      result = await probe.latest().purchaseProduct('coins_100', 'consumable');
    });

    expect(result).toMatchObject({
      userId: 'alice',
      productId: 'coins_100',
      type: 'consumable',
      quantity: 1,
    });
  });

  it('warns once that mock mode is on', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await mount(baseConfig({ mockMode: true }), 'alice');
    expect(warn.mock.calls.flat().join(' ')).toMatch(/mockMode is enabled/);
  });
});

describe('unmount', () => {
  it('stops applying server state that arrives late', async () => {
    // The mount effect guards every setState with `cancelled`; without it React
    // warns and, worse, the provider would resurrect state after teardown.
    let release!: (value: Response) => void;
    vi.stubGlobal('fetch', (input: string | URL) => {
      if (String(input).includes('/onesub/status')) {
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
      }
      return Promise.resolve(new Response(JSON.stringify({ entitlements: {} }), { status: 200 }));
    });

    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    await act(async () => {
      root.render(
        createElement(OneSubProvider, { config: baseConfig(), userId: 'alice', children: null }),
      );
    });
    await act(async () => {
      root.unmount();
    });

    // The in-flight status request resolves only now, after teardown.
    await act(async () => {
      release(new Response(JSON.stringify({ active: true, subscription: null }), { status: 200 }));
    });

    expect(errors).not.toHaveBeenCalled();
    // Re-create a root so afterEach's unmount stays valid.
    root = createRoot(container);
    errors.mockRestore();
  });
});

describe('re-mount on identity change', () => {
  it('re-reads status when userId changes', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (input: string | URL) => {
      const url = String(input);
      if (url.includes('/onesub/status')) {
        calls.push(url);
        return new Response(JSON.stringify({ active: false, subscription: null }), { status: 200 });
      }
      return new Response(JSON.stringify({ entitlements: {} }), { status: 200 });
    });

    await mount(baseConfig(), 'alice');
    await rerender(baseConfig(), 'bob');

    expect(calls.some((u) => u.includes('alice'))).toBe(true);
    expect(calls.some((u) => u.includes('bob'))).toBe(true);
  });

  it('does not re-read status for an unrelated config change', async () => {
    // The mount effect depends on serverUrl/userId only, on purpose — re-running
    // it re-opens the IAP connection and replays queued transactions.
    let statusCalls = 0;
    vi.stubGlobal('fetch', async (input: string | URL) => {
      const url = String(input);
      if (url.includes('/onesub/status')) {
        statusCalls++;
        return new Response(JSON.stringify({ active: false, subscription: null }), { status: 200 });
      }
      return new Response(JSON.stringify({ entitlements: {} }), { status: 200 });
    });

    await mount(baseConfig({ debug: false }), 'alice');
    await rerender(baseConfig({ debug: true }), 'alice');

    expect(statusCalls).toBe(1);
  });
});
