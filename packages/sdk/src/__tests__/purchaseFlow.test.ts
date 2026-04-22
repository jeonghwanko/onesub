import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ONESUB_ERROR_CODE } from '@onesub/shared';
import { OneSubError } from '../OneSubError.js';
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
// Error codes — rejections are OneSubError with correct .code
// ---------------------------------------------------------------------------
describe('error codes on rejection', () => {
  it('missing receipt → NO_RECEIPT_DATA', async () => {
    const inFlight = new Map<string, InFlightEntry>();
    let rejected: unknown = null;
    inFlight.set('premium', {
      kind: 'purchase',
      purchaseType: 'non_consumable',
      resolve: () => {},
      reject: (e) => { rejected = e; },
    });

    const deps = makeDeps({ inFlight });
    await handlePurchaseEvent({ productId: 'premium' }, deps);

    expect(rejected).toBeInstanceOf(OneSubError);
    expect((rejected as OneSubError).code).toBe(ONESUB_ERROR_CODE.NO_RECEIPT_DATA);
  });

  it('server validateReceipt error passes through errorCode', async () => {
    const inFlight = new Map<string, InFlightEntry>();
    let rejected: unknown = null;
    inFlight.set('pro', {
      kind: 'subscription',
      resolve: () => {},
      reject: (e) => { rejected = e; },
    });

    const validateReceipt = vi.fn().mockResolvedValue({
      valid: false,
      error: 'Apple not set',
      errorCode: ONESUB_ERROR_CODE.APPLE_CONFIG_MISSING,
    });

    const deps = makeDeps({
      inFlight,
      api: { validateReceipt, validatePurchase: vi.fn() },
    });
    await handlePurchaseEvent(makePurchase({ productId: 'pro', productType: 'subs' }), deps);

    expect(rejected).toBeInstanceOf(OneSubError);
    expect((rejected as OneSubError).code).toBe(ONESUB_ERROR_CODE.APPLE_CONFIG_MISSING);
  });

  it('server validatePurchase unknown errorCode falls back to RECEIPT_VALIDATION_FAILED', async () => {
    const inFlight = new Map<string, InFlightEntry>();
    let rejected: unknown = null;
    inFlight.set('credits', {
      kind: 'purchase',
      purchaseType: 'consumable',
      resolve: () => {},
      reject: (e) => { rejected = e; },
    });

    const validatePurchase = vi.fn().mockResolvedValue({
      valid: false,
      error: 'garbled',
      errorCode: 'NOT_A_REAL_CODE',
    });

    const deps = makeDeps({
      inFlight,
      api: { validateReceipt: vi.fn(), validatePurchase },
    });
    await handlePurchaseEvent(makePurchase({ productId: 'credits' }), deps);

    expect(rejected).toBeInstanceOf(OneSubError);
    expect((rejected as OneSubError).code).toBe(ONESUB_ERROR_CODE.RECEIPT_VALIDATION_FAILED);
  });

  it('concurrent registerInFlight → CONCURRENT_PURCHASE', async () => {
    const inFlight = new Map<string, InFlightEntry>();
    registerInFlight(inFlight, 'pro', 'subscription', undefined);
    const second = registerInFlight(inFlight, 'pro', 'subscription', undefined);
    await expect(second).rejects.toBeInstanceOf(OneSubError);
    await expect(second).rejects.toMatchObject({ code: ONESUB_ERROR_CODE.CONCURRENT_PURCHASE });
  });
});

// ---------------------------------------------------------------------------
// Regression: drain-window race
// User taps Subscribe RIGHT AFTER mount, so their in-flight entry is already
// registered when StoreKit's queued `Transaction.updates` replay finally fires.
// Without the drain gate, listener resolves their in-flight with the stale
// transaction → "sheet didn't show, immediately restored" bug.
//
// With `allowInFlightMatching: () => false` during drain, the replay is
// routed to the orphan-silent path even though an in-flight entry exists,
// and the user's promise stays pending — ready to receive the fresh event
// once the StoreKit sheet is confirmed.
// ---------------------------------------------------------------------------
describe('regression: mount drain window suppresses in-flight matching', () => {
  it('during drain, replay event does NOT resolve the matching in-flight entry', async () => {
    const inFlight = new Map<string, InFlightEntry>();
    let resolved: unknown = null;
    let rejected: Error | null = null;

    // User tapped Subscribe DURING the mount drain window
    inFlight.set('pro_monthly', {
      kind: 'subscription',
      resolve: (v) => { resolved = v; },
      reject: (e) => { rejected = e; },
    });

    const finishTransaction = vi.fn().mockResolvedValue(undefined);
    const onSubscriptionActivated = vi.fn();
    const validateReceipt = vi.fn().mockResolvedValue({
      valid: true,
      subscription: { userId: 'user_1', productId: 'pro_monthly' },
      action: 'restored',
    });

    const deps = makeDeps({
      inFlight,
      RNIap: { finishTransaction },
      api: { validateReceipt, validatePurchase: vi.fn() },
      onSubscriptionActivated,
      allowInFlightMatching: () => false, // drain active
    });

    // StoreKit delivers the queued replay for the same productId
    await handlePurchaseEvent(
      makePurchase({ productId: 'pro_monthly', productType: 'subs', transactionId: 'stale_tx' }),
      deps,
    );

    // The replay was processed silently (finished, state updated) but the
    // user's promise is STILL pending — they will see the StoreKit sheet
    // once drain closes and requestPurchase is called.
    expect(resolved).toBeNull();
    expect(rejected).toBeNull();
    expect(inFlight.has('pro_monthly')).toBe(true); // entry preserved
    expect(finishTransaction).toHaveBeenCalledOnce(); // replay still finished
    expect(onSubscriptionActivated).toHaveBeenCalledOnce();
  });

  it('after drain closes, a fresh event resolves the preserved in-flight entry', async () => {
    const inFlight = new Map<string, InFlightEntry>();
    let resolved: unknown = null;
    inFlight.set('pro_monthly', {
      kind: 'subscription',
      resolve: (v) => { resolved = v; },
      reject: () => {},
    });

    const finishTransaction = vi.fn().mockResolvedValue(undefined);
    const validateReceipt = vi.fn().mockResolvedValue({
      valid: true,
      subscription: { userId: 'user_1', productId: 'pro_monthly' },
      action: 'new',
    });

    // Flip the gate mid-test: first a replay (during drain), then the fresh
    // event after drain.
    let drainOpen = false;
    const deps = makeDeps({
      inFlight,
      RNIap: { finishTransaction },
      api: { validateReceipt, validatePurchase: vi.fn() },
      allowInFlightMatching: () => drainOpen,
    });

    // Replay during drain — should be silent, in-flight preserved
    await handlePurchaseEvent(
      makePurchase({ productId: 'pro_monthly', productType: 'subs', transactionId: 'stale' }),
      deps,
    );
    expect(resolved).toBeNull();
    expect(inFlight.has('pro_monthly')).toBe(true);

    // Drain closes, user's requestPurchase succeeds, fresh event arrives
    drainOpen = true;
    await handlePurchaseEvent(
      makePurchase({ productId: 'pro_monthly', productType: 'subs', transactionId: 'fresh' }),
      deps,
    );

    expect(resolved).toMatchObject({ valid: true, action: 'new' });
    expect(inFlight.has('pro_monthly')).toBe(false);
    expect(finishTransaction).toHaveBeenCalledTimes(2);
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
