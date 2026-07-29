/**
 * Shared FUTURE / PRESENT / PAST classification with a ±60s tolerance
 * buffer around "now". Used anywhere a scheduledTimestamp vs. currentTimestamp
 * comparison decides whether something should fire immediately, wait, or be
 * treated as expired.
 *
 * Why a buffer at all: comparing two `Date`/`Date.now()` values with strict
 * `<` / `>` breaks at the exact-match edge (e.g. contact added at 7:38:00.000
 * PM with expiry also at 7:38 PM — by the time the comparison runs a few ms
 * have always passed, so a strict `expiry < now` is always true and the
 * message gets silently treated as already-expired instead of due-now).
 *
 *   Future : scheduledTimestamp > currentTimestamp + PRESENT_WINDOW_MS
 *   Present: |scheduledTimestamp - currentTimestamp| <= PRESENT_WINDOW_MS
 *   Past   : scheduledTimestamp < currentTimestamp - PRESENT_WINDOW_MS
 */
export const PRESENT_WINDOW_MS = 60 * 1000; // 60s

/**
 * @param {number} scheduledTimestamp - ms epoch of the target time (expiry, alarm, etc.)
 * @param {number} currentTimestamp   - ms epoch of "now" (defaults to Date.now())
 * @returns {'FUTURE' | 'PRESENT' | 'PAST'}
 */
export const classifyTiming = (scheduledTimestamp, currentTimestamp = Date.now()) => {
  const diff = scheduledTimestamp - currentTimestamp;
  if (diff > PRESENT_WINDOW_MS) return 'FUTURE';
  if (diff < -PRESENT_WINDOW_MS) return 'PAST';
  return 'PRESENT';
};

export const isPresent = (scheduledTimestamp, currentTimestamp = Date.now()) =>
  classifyTiming(scheduledTimestamp, currentTimestamp) === 'PRESENT';

export const isFuture = (scheduledTimestamp, currentTimestamp = Date.now()) =>
  classifyTiming(scheduledTimestamp, currentTimestamp) === 'FUTURE';

export const isPast = (scheduledTimestamp, currentTimestamp = Date.now()) =>
  classifyTiming(scheduledTimestamp, currentTimestamp) === 'PAST';
