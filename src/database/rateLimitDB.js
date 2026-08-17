import { getDB } from './db';
import { handleError } from '../utils/errorHandler';
import { getNow } from '../utils/devClock';

/**
 * Per-platform rate limiting — each platform (SMS, WhatsApp, Email,
 * Gmail, custom) can have its own send limit over its own custom time
 * window (e.g. "5 per hour", "20 per 30 minutes", "1 per 90 minutes").
 * No row for a platform = unlimited, same as the old default behavior
 * for every platform except SMS.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Validation — every JSDoc in this file always said "positive integer" but
// nothing at the data layer ever enforced it, and validateTierMonotonicity
// (below) was only ever called from SettingsScreen.js, not from
// setRateLimitTier() itself. That meant any OTHER caller — a different
// screen, dev tooling, a migration, a future feature — could write
// limitCount <= 0 (silently bricks the platform forever, since 0 sent is
// always >= a 0 or negative limit), windowMinutes <= 0 (collapses SQLite's
// `'-' || windowMinutes || ' minutes'` into "now" or a positive offset,
// breaking the whole rolling-window calculation), or an inconsistent tier
// set entirely — with zero protection, regardless of which UI (if any)
// put the numbers together. Enforcing both here means every caller is
// protected, not just the one screen that happens to check first today.
// ─────────────────────────────────────────────────────────────────────────────
const isPositiveInteger = (n) => Number.isInteger(n) && n > 0;

export const getRateLimit = (platformId) => {
  try {
    const db = getDB();
    const row = db.execute(
      'SELECT limit_count, window_minutes FROM platform_rate_limits WHERE platform_id = ?;',
      [platformId],
    ).rows?._array?.[0];
    if (!row) return null;
    return { limitCount: row.limit_count, windowMinutes: row.window_minutes };
  } catch (error) {
    handleError(error, 'getRateLimit');
    return null;
  }
};

export const getAllRateLimits = () => {
  try {
    const db = getDB();
    const rows = db.execute('SELECT * FROM platform_rate_limits;').rows?._array ?? [];
    const map = {};
    rows.forEach((r) => {
      map[r.platform_id] = { limitCount: r.limit_count, windowMinutes: r.window_minutes };
    });
    return map;
  } catch (error) {
    handleError(error, 'getAllRateLimits');
    return {};
  }
};

/**
 * @param {string} platformId
 * @param {number} limitCount     Positive integer — max sends allowed per window.
 * @param {number} windowMinutes  Positive integer — rolling window length in minutes
 *                                 (e.g. 90 for "1 hour 30 minutes").
 */
export const setRateLimit = (platformId, limitCount, windowMinutes) => {
  if (!isPositiveInteger(limitCount) || !isPositiveInteger(windowMinutes)) {
    handleError(
      new Error(`setRateLimit requires positive integers — got limitCount=${limitCount}, windowMinutes=${windowMinutes}.`),
      'setRateLimit',
    );
    return false;
  }
  try {
    const db = getDB();
    db.execute(
      `INSERT INTO platform_rate_limits (platform_id, limit_count, window_minutes)
       VALUES (?, ?, ?)
       ON CONFLICT(platform_id) DO UPDATE SET limit_count = excluded.limit_count, window_minutes = excluded.window_minutes;`,
      [platformId, limitCount, windowMinutes],
    );
    return true;
  } catch (error) {
    handleError(error, 'setRateLimit');
    return false;
  }
};

// Removing the row = unlimited for that platform again.
export const clearRateLimit = (platformId) => {
  try {
    const db = getDB();
    db.execute('DELETE FROM platform_rate_limits WHERE platform_id = ?;', [platformId]);
    return true;
  } catch (error) {
    handleError(error, 'clearRateLimit');
    return false;
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// platform_rate_limit_tiers — the DEFAULT, DB-driven, user-editable tiers
// (e.g. SMS: 150/15min, 250/1hr, 750/24hr). Multiple tiers can coexist per
// platform; ALL of them must hold simultaneously for a send to be allowed
// (AND logic — enforced in queueUtils.isRateLimited, not here). This table
// is the source of truth: nothing is hardcoded in code, so editing/adding/
// removing tiers from Settings takes effect immediately.
// ─────────────────────────────────────────────────────────────────────────────

// All tiers currently configured for one platform, ordered by window so the
// UI/logs read smallest-window-first.
export const getRateLimitTiers = (platformId) => {
  try {
    const db = getDB();
    const rows = db.execute(
      'SELECT window_minutes, limit_count FROM platform_rate_limit_tiers WHERE platform_id = ? ORDER BY window_minutes ASC;',
      [platformId],
    ).rows?._array ?? [];
    return rows.map((r) => ({ windowMinutes: r.window_minutes, limitCount: r.limit_count }));
  } catch (error) {
    handleError(error, 'getRateLimitTiers');
    return [];
  }
};

// Every platform's tiers in one call, grouped by platform_id — handy for the
// Settings screen so it doesn't have to query per-platform.
export const getAllRateLimitTiers = () => {
  try {
    const db = getDB();
    const rows = db.execute(
      'SELECT platform_id, window_minutes, limit_count FROM platform_rate_limit_tiers ORDER BY platform_id ASC, window_minutes ASC;',
    ).rows?._array ?? [];
    const map = {};
    rows.forEach((r) => {
      if (!map[r.platform_id]) map[r.platform_id] = [];
      map[r.platform_id].push({ windowMinutes: r.window_minutes, limitCount: r.limit_count });
    });
    return map;
  } catch (error) {
    handleError(error, 'getAllRateLimitTiers');
    return {};
  }
};

/**
 * Validates that a set of tiers is internally consistent: any tier with a
 * LARGER window must have a limitCount STRICTLY GREATER than every tier
 * with a smaller window. A longer rolling window always contains every
 * shorter window's sends as a subset (e.g. every send counted in a 15-min
 * window is also counted in the 1-hr window that contains it), so a
 * longer window's cap can never be lower than — or equal to — a shorter
 * window's cap without being a contradiction.
 *
 * General-purpose: works for any number of tiers, not hardcoded to
 * 15min/1hr/24hr, so a custom tier (6hr, 12hr, etc.) is validated the
 * same way automatically. Sorts by window first, then only needs to
 * compare each tier against its immediate neighbor — that single pass
 * transitively covers every pair (15min<1hr, 1hr<24hr, AND 15min<24hr).
 *
 * @param {Array<{ windowMinutes: number, limitCount: number }>} tiers
 * @returns {{ valid: true } | { valid: false, error: string }}
 */
export const validateTierMonotonicity = (tiers) => {
  if (!Array.isArray(tiers) || tiers.length < 2) {
    return { valid: true }; // nothing to compare against
  }

  const sorted = [...tiers].sort((a, b) => a.windowMinutes - b.windowMinutes);

  for (let i = 1; i < sorted.length; i++) {
    const smaller = sorted[i - 1];
    const larger = sorted[i];

    if (smaller.windowMinutes === larger.windowMinutes) {
      return {
        valid: false,
        error: `Two tiers can't share the same ${smaller.windowMinutes}-minute window.`,
      };
    }

    if (larger.limitCount <= smaller.limitCount) {
      return {
        valid: false,
        error: `The ${larger.windowMinutes}-minute tier's limit (${larger.limitCount}) must be greater than the ${smaller.windowMinutes}-minute tier's limit (${smaller.limitCount}) — a longer window always contains the shorter one, so its cap can't be lower or equal.`,
      };
    }
  }

  return { valid: true };
};

/**
 * Upsert one tier for a platform. Same (platformId, windowMinutes) pair
 * updates the existing tier's count instead of duplicating it.
 * @param {string} platformId
 * @param {number} windowMinutes  Positive integer — this tier's rolling window length in minutes.
 * @param {number} limitCount     Positive integer — max sends allowed within that window.
 */
export const setRateLimitTier = (platformId, windowMinutes, limitCount) => {
  if (!isPositiveInteger(windowMinutes) || !isPositiveInteger(limitCount)) {
    handleError(
      new Error(`setRateLimitTier requires positive integers — got windowMinutes=${windowMinutes}, limitCount=${limitCount}.`),
      'setRateLimitTier',
    );
    return false;
  }

  // Same "replace this window or append" candidate-set construction
  // SettingsScreen.js already does before calling this — replicated here
  // so the check holds regardless of caller, not just the one UI screen.
  const existingTiers = getRateLimitTiers(platformId);
  const candidateTiers = [
    ...existingTiers.filter((t) => t.windowMinutes !== windowMinutes),
    { windowMinutes, limitCount },
  ];
  const monotonicityCheck = validateTierMonotonicity(candidateTiers);
  if (!monotonicityCheck.valid) {
    handleError(new Error(monotonicityCheck.error), 'setRateLimitTier');
    return false;
  }

  try {
    const db = getDB();
    db.execute(
      `INSERT INTO platform_rate_limit_tiers (platform_id, window_minutes, limit_count)
       VALUES (?, ?, ?)
       ON CONFLICT(platform_id, window_minutes) DO UPDATE SET limit_count = excluded.limit_count;`,
      [platformId, windowMinutes, limitCount],
    );
    return true;
  } catch (error) {
    handleError(error, 'setRateLimitTier');
    return false;
  }
};

// Remove a single tier (e.g. user deletes the "24 hour" row but keeps the
// other two). Removing every tier for a platform = unlimited via the
// default scheme, same "no row = unlimited" convention as the rest of this
// module.
export const deleteRateLimitTier = (platformId, windowMinutes) => {
  try {
    const db = getDB();
    db.execute(
      'DELETE FROM platform_rate_limit_tiers WHERE platform_id = ? AND window_minutes = ?;',
      [platformId, windowMinutes],
    );
    return true;
  } catch (error) {
    handleError(error, 'deleteRateLimitTier');
    return false;
  }
};

// How many messages this platform has actually sent within its own
// rolling window (right now). Same rolling-window approach, any platform,
// any window length.
export const countSentInWindow = (platformId, windowMinutes) => {
  try {
    const db = getDB();
    // sent_at is stored as JS ISO ("...T...Z"). Comparing raw strings is
    // broken (format mismatch vs SQLite's own datetime() output);
    // datetime(sent_at) fixed that, but datetime() formats its result as
    // a STRING at whole-SECOND precision, silently dropping fractional
    // seconds — a send could be counted as "in window" for up to ~1s
    // past its true millisecond boundary (confirmed on a real device: a
    // retry-alarm fired exactly on schedule but still found the platform
    // blocked, 0 progress). julianday() returns a floating-point day
    // count instead, preserving sub-second precision — this is an exact
    // Sliding Window Log comparison, not an approximation.
    const result = db.execute(
      `SELECT COUNT(*) as count FROM message_queue
       WHERE platform_id = ? AND status = 'SENT'
       AND julianday(sent_at) >= julianday('now', '-' || ? || ' minutes');`,
      [platformId, windowMinutes],
    );
    return result.rows?._array?.[0]?.count ?? 0;
  } catch (error) {
    handleError(error, 'countSentInWindow');
    return 0;
  }
};

/**
 * Full send history for one platform, as ms timestamps sorted ascending —
 * used to hydrate the in-memory rate-limit engine's history on each run so
 * sliding-window counts don't repeatedly rescan the DB. Source of truth is
 * message_queue.sent_at (set only on SENT rows), so persistence after a
 * restart is exactly "re-read these rows".
 *
 * @param {string} platformId
 * @param {number} [sinceMs=0]  drop rows older than this (e.g. now - max window)
 * @returns {number[]}  ascending ms timestamps of every SENT row
 */
export const getSentHistoryForPlatform = (platformId, sinceMs = 0) => {
  try {
    const db = getDB();
    // julianday(sent_at) — NOT strftime('%s', datetime(sent_at)) * 1000.
    // strftime('%s', ...) returns whole SECONDS (its one-second minimum
    // resolution), so multiplying by 1000 silently truncated every
    // timestamp to the nearest second before it ever reached the engine's
    // history array — reintroducing, inside calculateNextSafeSendTime's
    // otherwise-exact millisecond math, the same whole-second precision
    // loss already found and fixed once in countSentInWindow (confirmed
    // on a real device: a retry-alarm fired exactly on schedule but the
    // platform was still reported blocked). julianday() is a
    // floating-point day count with sub-second precision, and — like
    // datetime() — robustly parses both the app's ISO format and the
    // space-separated format raw backdating/UPDATE statements can leave
    // behind, so no dual-format robustness is lost by switching.
    const result = db.execute(
      `SELECT julianday(sent_at) AS sent_at_jd
       FROM message_queue
       WHERE platform_id = ? AND status = 'SENT' AND sent_at IS NOT NULL
       ORDER BY julianday(sent_at) ASC;`,
      [platformId],
    );
    const rows = result.rows?._array ?? [];
    // Was Date.now() — REAL wall-clock time. That silently broke the Time
    // Machine (accelerated virtual clock, see devClock.js): at any speed
    // above ~1x, a virtual sent_at quickly reads as "more than 60s in the
    // future" relative to the real clock, so EVERY previously-sent row got
    // dropped by the guard below — the engine then saw an empty/near-empty
    // history, believed no tier was anywhere near its cap, and kept
    // sending far past the configured limit (confirmed: 900x speed sent
    // 200 messages straight through a 150/15min tier with zero blocking).
    // getNow() returns the virtual time whenever the Time Machine is
    // running, and is identical to Date.now() otherwise — so this fix is a
    // no-op for real-time (non-accelerated) runs.
    const nowMs = getNow();
    const out = [];
    // Unix epoch (1970-01-01T00:00:00Z) is Julian day 2440587.5 — exact,
    // standard constant, not an approximation.
    const JULIAN_DAY_UNIX_EPOCH = 2440587.5;
    for (const r of rows) {
      const jd = Number(r.sent_at_jd);
      if (isNaN(jd)) continue;
      const t = Math.round((jd - JULIAN_DAY_UNIX_EPOCH) * 86400000);
      if (t < sinceMs) continue;
      // Clock-jump guard: a row timestamped far in the future would sit "in
      // every window" forever. Drop it (same guard the engine's appendSend
      // applies in reverse for backwards jumps).
      if (t > nowMs + 60000) continue;
      out.push(t);
    }
    return out;
  } catch (error) {
    handleError(error, 'getSentHistoryForPlatform');
    return [];
  }
};

/**
 * When will this platform's rolling window free up by (at least) one
 * slot? Finds the OLDEST SENT row still inside the window — that row is
 * the next one to age out — and returns oldestSentAt + windowMinutes,
 * the exact ms timestamp at which it drops out of the window.
 *
 * Returns null if there's no SENT row in the window at all (nothing to
 * wait on — rate-limit isn't actually the blocker right now).
 */
export const getWindowFreeAtMs = (platformId, windowMinutes) => {
  try {
    const db = getDB();
    // julianday() here too — see countSentInWindow for why.
    const result = db.execute(
      `SELECT MIN(sent_at) as oldest FROM message_queue
       WHERE platform_id = ? AND status = 'SENT'
       AND julianday(sent_at) >= julianday('now', '-' || ? || ' minutes');`,
      [platformId, windowMinutes],
    );
    const oldest = result.rows?._array?.[0]?.oldest ?? null;
    if (!oldest) return null;

    const oldestMs = new Date(oldest).getTime();
    if (isNaN(oldestMs)) return null;

    return oldestMs + windowMinutes * 60 * 1000;
  } catch (error) {
    handleError(error, 'getWindowFreeAtMs');
    return null;
  }
};