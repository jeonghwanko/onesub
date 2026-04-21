import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  handlePurchaseEvent,
  registerInFlight,
  extractReceiptToken,
  isSubscriptionEvent,
  type InFlightEntry,
  type PurchaseFlowDeps,
} from '../purchaseFlow.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
function makeDeps(overrides: Partial<PurchaseFlowDeps> = {}): PurchaseFlowDeps {
  const inFlight = overrides.inFlight ?? new Map<string, InFlightEntry>();
  const RNIap = overrides.RNIap ?? {
    finishTransaction: vi.fn().mockResolvedValue(undefined),
  };
  const api = overrides.api ?? {
    validateReceipt: vi.fn(),
    validatePurchase: vi.fn(),
  };
  return {
    config: { serverUrl: 'https://api.test', productId: 'default' },
    userId: 'user_1',
    platform: 'ios',
    inFlight,
    RNIap,
    api,
    ...overrides,
  };
}

function makePurchase(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    productId: 'premium',
    purchaseToken: 'jws_token_abc',
    transactionId: 'tx_1',
    productType: 'inapp',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// extractReceiptToken
// ---------------------------------------------------------------------------
describe('extractReceiptToken', () => {
  it('returns unified purchaseToken (v15)', () => {
    expect(extractReceiptToken({ purchaseToken: 'abc' })).toBe('abc');
  });

  it('falls back to legacy transactionReceipt', () => {
    expect(extractReceiptToken({ transactionReceipt: 'legacy' })).toBe('legacy');
  });

  it('returns empty string for malformed input', () => {
    expect(extractReceiptToken(null)).toBe('');
    expect(extractReceiptToken({})).toBe('');
    expect(extractReceiptToken({ purchaseToken: '' })).toBe('');
  });
});

// ---------------------------------------------------------------------------
// isSubscriptionEvent
// ---------------------------------------------------------------------------
describe('isSubscriptionEvent', () => {
  it('respects in-flight kind when present', () => {
    const subEntry: InFlightEntry = {
      kind: 'subscription',
      resolve: () => {},
      reject: () => {},
    };
    expect(isSubscriptionEvent({ productType: 'inapp' }, subEntry)).toBe(true);

    const purchaseEntry: InFlightEntry = {
      kind: 'purchase',
      resolve: () => {},
      reject: () => {},
    };
    expect(isSubscriptionEvent({ productType: 'subs' }, purchaseEntry)).toBe(false);
  });

  it('falls back to productType for orphan events', () => {
    expect(isSubscriptionEvent({ productType: 'subs' }, undefined)).toBe(true);
    expect(isSubscriptionEvent({ productType: 'inapp' }, undefined)).toBe(false);
    expect(isSubscriptionEvent({ productType: 'auto-renewable' }, undefined)).toBe(true);
  });

  it('defaults to false when productType is missing (orphan event without context)', () => {
    expect(isSubscriptionEvent({}, undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// handlePurchaseEvent — subscription flow
// ---------------------------------------------------------------------------
describe('handlePurchaseEvent — subscription', () => {
  it('user-initiated subscribe: validates, finishes tx, resolves in-flight, calls onSubscriptionActivated', async () => {
    const inFlight = new Map<string, InFlightEntry>();
    let resolved: unknown = null;
    inFlight.set('pro_monthly', {
      kind: 'subscription',
      resolve: (v) => { resolved = v; },
      reject: () => {},
    });

    const onSubscriptionActivated = vi.fn();
    const finishTransaction = vi.fn().mockResolvedValue(undefined);
    const validateReceipt = vi.fn().mockResolvedValue({
      valid: true,
      subscription: { userId: 'user_1', productId: 'pro_monthly', status: 'active' },
    });

    const deps = makeDeps({
      inFlight,
      RNIap: { finishTransaction },
      api: { validateReceipt, validatePurchase: vi.fn() },
      onSubscriptionActivated,
    });

    await handlePurchaseEvent(
      makePurchase({ productId: 'pro_monthly', productType: 'subs' }),
      deps,
    );

    expect(validateReceipt).toHaveBeenCalledOnce();
    expect(finishTransaction).toHaveBeenCalledWith({
      purchase: expect.objectContaining({ productId: 'pro_monthly' }),
      isConsumable: false,
    });
    expect(onSubscriptionActivated).toHaveBeenCalledWith(
      expect.objectContaining({ productId: 'pro_monthly' }),
    );
    expect(resolved).toMatchObject({ valid: true });
    expect(inFlight.has('pro_monthly')).toBe(false);
  });

  it('orphan subscription replay (no in-flight): still validates + finishes, updates isActive, no resolve call', async () => {
    const inFlight = new Map<string, InFlightEntry>();
    const onSubscriptionActivated = vi.fn();
    const finishTransaction = vi.fn().mockResolvedValue(undefined);
    const validateReceipt = vi.fn().mockResolvedValue({
      valid: true,
      subscription: { userId: 'user_1', productId: 'pro_monthly', status: 'active' },
    });

    const deps = makeDeps({
      inFlight,
      RNIap: { finishTransaction },
      api: { validateReceipt, validatePurchase: vi.fn() },
      onSubscriptionActivated,
    });

    // No in-flight — the mount listener processes the replay silently
    await handlePurchaseEvent(
      makePurchase({ productId: 'pro_monthly', productType: 'subs' }),
      deps,
    );

    expect(validateReceipt).toHaveBeenCalledOnce();
    expect(finishTransaction).toHaveBeenCalledOnce();
    expect(onSubscriptionActivated).toHaveBeenCalledOnce();
    // No matching in-flight entry means no promise to resolve — this is the
    // silent-replay-at-mount path that fixes the "결제 복구됨" bug.
  });

  it('server rejects subscription: does NOT finish transaction, rejects in-flight', async () => {
    const inFlight = new Map<string, InFlightEntry>();
    let rejection: Error | null = null;
    inFlight.set('pro_monthly', {
      kind: 'subscription',
      resolve: () => {},
      reject: (e) => { rejection = e; },
    });

    const finishTransaction = vi.fn().mockResolvedValue(undefined);
    const validateReceipt = vi.fn().mockResolvedValue({
      valid: false,
      error: 'INVALID_RECEIPT',
    });

    const deps = makeDeps({
      inFlight,
      RNIap: { finishTransaction },
      api: { validateReceipt, validatePurchase: vi.fn() },
    });

    await handlePurchaseEvent(
      makePurchase({ productId: 'pro_monthly', productType: 'subs' }),
      deps,
    );

    expect(finishTransaction).not.toHaveBeenCalled();
    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as unknown as Error).message).toContain('INVALID_RECEIPT');
    expect(inFlight.has('pro_monthly')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// handlePurchaseEvent — one-time purchase flow
// ---------------------------------------------------------------------------
describe('handlePurchaseEvent — purchase (non-consumable)', () => {
  it('user-initiated purchase: validates + finishes + resolves with action', async () => {
    const inFlight = new Map<string, InFlightEntry>();
    let resolved: { valid: boolean; action?: string } | null = null;
    inFlight.set('welcome_pass', {
      kind: 'purchase',
      purchaseType: 'non_consumable',
      resolve: (v) => { resolved = v as { valid: boolean; action?: string }; },
      reject: () => {},
    });

    const finishTransaction = vi.fn().mockResolvedValue(undefined);
    const validatePurchase = vi.fn().mockResolvedValue({
      valid: true,
      purchase: { productId: 'welcome_pass', transactionId: 'tx_1' },
      action: 'new',
    });

    const deps = makeDeps({
      inFlight,
      RNIap: { finishTransaction },
      api: { validateReceipt: vi.fn(), validatePurchase },
    });

    await handlePurchaseEvent(makePurchase({ productId: 'welcome_pass' }), deps);

    expect(validatePurchase).toHaveBeenCalledOnce();
    expect(finishTransaction).toHaveBeenCalledWith({
      purchase: expect.any(Object),
      isConsumable: false,
    });
    expect(resolved).toMatchObject({ valid: true, action: 'new' });
  });

  it('NON_CONSUMABLE_ALREADY_OWNED: synthesizes restored result + still finishes', async () => {
    const inFlight = new Map<string, InFlightEntry>();
    let resolved: { valid: boolean; action?: string } | null = null;
    inFlight.set('welcome_pass', {
      kind: 'purchase',
      purchaseType: 'non_consumable',
      resolve: (v) => { resolved = v as { valid: boolean; action?: string }; },
      reject: () => {},
    });

    const finishTransaction = vi.fn().mockResolvedValue(undefined);
    const validatePurchase = vi.fn().mockResolvedValue({
      valid: false,
      error: 'NON_CONSUMABLE_ALREADY_OWNED',
    });

    const deps = makeDeps({
      inFlight,
      RNIap: { finishTransaction },
      api: { validateReceipt: vi.fn(), validatePurchase },
    });

    await handlePurchaseEvent(makePurchase({ productId: 'welcome_pass' }), deps);

    expect(finishTransaction).toHaveBeenCalled();
    expect(resolved).toMatchObject({ valid: true, action: 'restored' });
  });
});

describe('handlePurchaseEvent — purchase (consumable)', () => {
  it('passes isConsumable:true to finishTransaction so Google Play consume API fires', async () => {
    const inFlight = new Map<string, InFlightEntry>();
    inFlight.set('coins_100', {
      kind: 'purchase',
      purchaseType: 'consumable',
      resolve: () => {},
      reject: () => {},
    });

    const finishTransaction = vi.fn().mockResolvedValue(undefined);
    const validatePurchase = vi.fn().mockResolvedValue({
      valid: true,
      purchase: { productId: 'coins_100', transactionId: 'tx_1' },
      action: 'new',
    });

    const deps = makeDeps({
      inFlight,
      platform: 'android',
      RNIap: { finishTransaction },
      api: { validateReceipt: vi.fn(), validatePurchase },
    });

    await handlePurchaseEvent(makePurchase({ productId: 'coins_100' }), deps);

    expect(finishTransaction).toHaveBeenCalledWith({
      purchase: expect.any(Object),
      isConsumable: true,
    });
  });
});

// ---------------------------------------------------------------------------
// handlePurchaseEvent — no-op and error paths
// ---------------------------------------------------------------------------
describe('handlePurchaseEvent — defensive paths', () => {
  it('no-ops on missing productId', async () => {
    const validateReceipt = vi.fn();
    const validatePurchase = vi.fn();
    await handlePurchaseEvent({} as unknown, makeDeps({
      api: { validateReceipt, validatePurchase },
    }));
    expect(validateReceipt).not.toHaveBeenCalled();
    expect(validatePurchase).not.toHaveBeenCalled();
  });

  it('rejects in-flight when receipt is missing', async () => {
    const inFlight = new Map<string, InFlightEntry>();
    let rejection: Error | null = null;
    inFlight.set('premium', {
      kind: 'purchase',
      purchaseType: 'non_consumable',
      resolve: () => {},
      reject: (e) => { rejection = e; },
    });

    const deps = makeDeps({ inFlight });
    await handlePurchaseEvent({ productId: 'premium' }, deps);

    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as unknown as Error).message).toContain('No receipt');
    expect(inFlight.has('premium')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// registerInFlight
// ---------------------------------------------------------------------------
describe('registerInFlight', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('creates an entry in the map and resolves on matching event', async () => {
    const inFlight = new Map<string, InFlightEntry>();
    const promise = registerInFlight(inFlight, 'pro_monthly', 'subscription', undefined);

    expect(inFlight.has('pro_monthly')).toBe(true);

    // Simulate listener resolving it
    inFlight.get('pro_monthly')!.resolve({ valid: true });
    await expect(promise).resolves.toMatchObject({ valid: true });
  });

  it('rejects when a second call happens while first is in-flight', async () => {
    const inFlight = new Map<string, InFlightEntry>();
    registerInFlight(inFlight, 'pro_monthly', 'subscription', undefined);
    const second = registerInFlight(inFlight, 'pro_monthly', 'subscription', undefined);
    await expect(second).rejects.toThrow(/already in progress/);
  });

  it('times out after configured interval', async () => {
    const inFlight = new Map<string, InFlightEntry>();
    const promise = registerInFlight(inFlight, 'pro_monthly', 'subscription', undefined, 5_000);

    vi.advanceTimersByTime(5_100);
    await expect(promise).rejects.toThrow(/timed out/);
    expect(inFlight.has('pro_monthly')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// End-to-end scenario: TestFlight stale pending replay + user taps Subscribe
// ---------------------------------------------------------------------------
describe('scenario: TestFlight replay at mount then user taps Subscribe', () => {
  it('stale replay processed silently; subsequent user-initiated event resolves cleanly', async () => {
    const inFlight = new Map<string, InFlightEntry>();
    const onSubscriptionActivated = vi.fn();
    const finishTransaction = vi.fn().mockResolvedValue(undefined);

    // Server for replays returns valid: true, action: 'restored' (idempotent)
    const validateReceipt = vi.fn()
      .mockResolvedValueOnce({
        valid: true,
        subscription: { userId: 'user_1', productId: 'pro_monthly', status: 'active' },
        action: 'restored',
      })
      .mockResolvedValueOnce({
        valid: true,
        subscription: { userId: 'user_1', productId: 'pro_monthly', status: 'active' },
        action: 'new',
      });

    const deps = makeDeps({
      inFlight,
      RNIap: { finishTransaction },
      api: { validateReceipt, validatePurchase: vi.fn() },
      onSubscriptionActivated,
    });

    // Step 1: StoreKit replays a pending transaction right after initConnection.
    // No user interaction yet, no in-flight entry. Listener must NOT resolve
    // anything. State gets updated via onSubscriptionActivated; transaction
    // is finished.
    await handlePurchaseEvent(
      makePurchase({ productId: 'pro_monthly', productType: 'subs', transactionId: 'stale_tx' }),
      deps,
    );

    expect(onSubscriptionActivated).toHaveBeenCalledOnce();
    expect(finishTransaction).toHaveBeenCalledOnce();
    expect(inFlight.size).toBe(0); // no dangling entries

    // Step 2: User taps Subscribe. registerInFlight creates the slot. Fresh
    // StoreKit transaction arrives (after the sheet). Listener resolves.
    const subscribePromise = registerInFlight(inFlight, 'pro_monthly', 'subscription', undefined);
    await handlePurchaseEvent(
      makePurchase({ productId: 'pro_monthly', productType: 'subs', transactionId: 'fresh_tx' }),
      deps,
    );

    await expect(subscribePromise).resolves.toMatchObject({
      valid: true,
      action: 'new',
    });
    expect(finishTransaction).toHaveBeenCalledTimes(2);
    expect(onSubscriptionActivated).toHaveBeenCalledTimes(2);
  });
});
