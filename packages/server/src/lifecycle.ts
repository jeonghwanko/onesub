import type { SubscriptionInfo } from '@onesub/shared';

/**
 * Ordering rule for subscription state: apply a snapshot of store state only if
 * it is not older than the newest one already applied.
 *
 * Every write to a subscription record comes from a snapshot taken at some
 * instant — an Apple notification's `signedDate`, an Apple transaction's
 * `signedDate`, a Google RTDN's `eventTimeMillis`, or the moment the server read
 * live state from Google Play / the App Store Server API. Deliveries arrive out
 * of order and are retried, so applying them in arrival order lets a late
 * EXPIRED roll back a renewal, or a late ON_HOLD stick after recovery. Apple's
 * own guidance is the same rule: "use the notification with the most recent
 * signedDate, because it contains the most recent snapshot".
 *
 * The record's `stateAsOf` holds the time of the newest snapshot applied.
 * Records written before the field existed have none, and are not guarded.
 */

/** True when `asOf` is strictly older than the record's last applied snapshot. */
export function isStaleSnapshot(
  existing: Pick<SubscriptionInfo, 'stateAsOf'> | null | undefined,
  asOf: string | undefined,
): boolean {
  if (!asOf || !existing?.stateAsOf) return false;
  return Date.parse(asOf) < Date.parse(existing.stateAsOf);
}

/** The latest of the given ISO times, ignoring undefined. */
export function laterStateAsOf(...times: Array<string | undefined>): string | undefined {
  let latest: string | undefined;
  for (const t of times) {
    if (t && (!latest || Date.parse(t) > Date.parse(latest))) latest = t;
  }
  return latest;
}

/** Largest epoch-ms value a JS Date can hold; beyond it `toISOString()` throws. */
const MAX_DATE_MS = 8.64e15;

/**
 * ISO time from a store-supplied epoch-ms value (number or numeric string), or
 * undefined when it is missing or not a representable time. For dates that may
 * lie in the future, such as an expiry; snapshot times use `snapshotTimeFromEpochMs`.
 */
export function isoFromEpochMs(ms: number | string | undefined | null): string | undefined {
  if (ms === undefined || ms === null || ms === '') return undefined;
  const n = typeof ms === 'number' ? ms : Number(ms);
  if (!Number.isFinite(n) || n <= 0 || n > MAX_DATE_MS) return undefined;
  return new Date(n).toISOString();
}

/**
 * How far ahead of our clock a snapshot time may be and still count. Apple and
 * Google sign with their own clocks; beyond small skew, a future snapshot time
 * is bogus — and storing one would freeze the record, since every genuine later
 * snapshot would then look older.
 */
const MAX_FUTURE_SKEW_MS = 10 * 60_000;

/** `isoFromEpochMs` for a snapshot time: also undefined when implausibly in the future. */
export function snapshotTimeFromEpochMs(
  ms: number | string | undefined | null,
  nowMs: number = Date.now(),
): string | undefined {
  const iso = isoFromEpochMs(ms);
  return iso && Date.parse(iso) <= nowMs + MAX_FUTURE_SKEW_MS ? iso : undefined;
}
