/**
 * Sandbox-only entitlement overrides for manual testing.
 *
 * Why this exists: Apple provides no way to cancel a sandbox subscription that
 * was bought with a real Apple Account through TestFlight. "Clear Purchase
 * History" in App Store Connect only covers sandbox *tester* accounts, and the
 * store expires an accelerated subscription on its own schedule. A developer
 * who subscribes once to check the paywall is therefore stuck as an entitled
 * user, and cannot re-run the purchase flow — the exact situation that hid a
 * paywall entry point from App Review (PenguinRun 2.0.6, Guideline 2.1(b)).
 *
 * Deleting server records does not help: `/onesub/validate` re-derives
 * entitlement from Apple on every call, so any local edit is overwritten the
 * next time the app launches. The override has to sit in front of that verdict.
 *
 * Safety model — an override can never affect a paying customer:
 *   - it is keyed by userId, so it touches exactly one account;
 *   - it is honoured ONLY when the receipt Apple just validated came from
 *     Sandbox (`SubscriptionInfo.sandbox`), so a Production receipt ignores it
 *     even if an override for that userId exists;
 *   - it lives behind the admin secret, like every other admin route;
 *   - it is process-local and non-persistent, so it cannot outlive a deploy or
 *     silently linger in a database. Multi-instance deployments must set it on
 *     the instance under test (or run one instance) — deliberate, so this stays
 *     a debugging aid rather than a product feature.
 */

/** userId -> forced entitlement. `false` means "treat as not entitled". */
const overrides = new Map<string, boolean>();

export function setTestOverride(userId: string, entitled: boolean): void {
  overrides.set(userId, entitled);
}

export function clearTestOverride(userId: string): boolean {
  return overrides.delete(userId);
}

export function getTestOverride(userId: string): boolean | undefined {
  return overrides.get(userId);
}

export function listTestOverrides(): Array<{ userId: string; entitled: boolean }> {
  return [...overrides].map(([userId, entitled]) => ({ userId, entitled }));
}

/** Test seam — resets state between suites. */
export function clearAllTestOverrides(): void {
  overrides.clear();
}
