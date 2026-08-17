/**
 * Shared scheduler constants used by both the live scheduler and dev simulation.
 * Single source of truth so the two never drift.
 */

/**
 * When the computed next-safe-send-time is within this many ms of "now", the
 * lane/single-item path waits inline (await delay) instead of reverting the
 * batch and arming a retry alarm. Beyond this, the wait is long enough that
 * holding the claim in memory (and the reservation) is wasteful, so we revert
 * to PENDING and let the native retry alarm pick the work back up at the exact
 * safe time. Kept small so the inline path only covers inter-item pacing
 * (≈1s execution+gap), never long recovery waits.
 */
export const MAX_INLINE_DELAY_MS = 3000;

/** Maximum grace period (ms) after a template's exact send_time during which
 * it is still eligible to be picked up by runExpiryCheck. Prevents a template
 * scheduled for 5 PM from being picked up at 8 PM.
 */
export const MAX_TEMPLATE_GRACE_PERIOD_MS = 60 * 60 * 1000; // 1 hour

/** How far back the expiry check scans (no lower bound — overdue contacts
 * from any past date are still eligible for negative-days_before templates). */
export const FAR_PAST_YEARS = 20;

/** How far forward the expiry check scans (upper bound for the date range). */
export const FAR_FUTURE_YEARS = 2;
