/**
 * Shared scheduler constants used by both the live scheduler and dev simulation.
 * Single source of truth so the two never drift.
 */

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
