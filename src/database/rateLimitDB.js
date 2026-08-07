import { getDB } from './db';
import { handleError } from '../utils/errorHandler';

/**
 * Per-platform rate limiting — each platform (SMS, WhatsApp, Email,
 * Gmail, custom) can have its own send limit over its own custom time
 * window (e.g. "5 per hour", "20 per 30 minutes", "1 per 90 minutes").
 * No row for a platform = unlimited, same as the old default behavior
 * for every platform except SMS.
 */

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
 * Upsert one tier for a platform. Same (platformId, windowMinutes) pair
 * updates the existing tier's count instead of duplicating it.
 * @param {string} platformId
 * @param {number} windowMinutes  Positive integer — this tier's rolling window length in minutes.
 * @param {number} limitCount     Positive integer — max sends allowed within that window.
 */
export const setRateLimitTier = (platformId, windowMinutes, limitCount) => {
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
    // sent_at is stored as JS ISO ("...T...Z"), but datetime('now', ...)
    // returns SQLite's own space-separated format. Comparing them as raw
    // strings is broken — 'T' (0x54) sorts after ' ' (0x20), so any
    // same-day ISO timestamp always compares as ">= " the cutoff no
    // matter how old it actually is. datetime(sent_at) normalizes it to
    // SQLite's format first, so the comparison is a real time comparison.
    const result = db.execute(
      `SELECT COUNT(*) as count FROM message_queue
       WHERE platform_id = ? AND status = 'SENT'
       AND datetime(sent_at) >= datetime('now', '-' || ? || ' minutes');`,
      [platformId, windowMinutes],
    );
    return result.rows?._array?.[0]?.count ?? 0;
  } catch (error) {
    handleError(error, 'countSentInWindow');
    return 0;
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
    const result = db.execute(
      `SELECT MIN(sent_at) as oldest FROM message_queue
       WHERE platform_id = ? AND status = 'SENT'
       AND datetime(sent_at) >= datetime('now', '-' || ? || ' minutes');`,
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