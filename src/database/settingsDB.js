import { getDB } from './db';
import { handleError } from '../utils/errorHandler';

export const SETTINGS_KEYS = {
  DEFAULT_PLATFORM: 'default_platform', // 'sms' | 'whatsapp' | 'email' | 'gmail' | null
  SMS_PER_HOUR_LIMIT: 'sms_per_hour_limit', // number stored as string, e.g. '300'
  // Not a standalone key — a prefix for a per-platform dynamic key
  // (RATE_LIMIT_RETRY_PREFIX + platformId, e.g. 'retry_next_at_sms').
  // Can't be a flat entry like the ones above since it's parameterized.
  RATE_LIMIT_RETRY_PREFIX: 'retry_next_at_',
};

// ---------------------------------------------------------------------------
// Generic helpers
// ---------------------------------------------------------------------------

export const getSetting = (key) => {
  try {
    const db = getDB();
    const result = db.execute('SELECT value FROM settings WHERE key = ?;', [key]);
    const row = result.rows?._array?.[0];
    return row ? row.value : null;
  } catch (error) {
    handleError(error, 'getSetting');
    return null;
  }
};

export const setSetting = (key, value) => {
  try {
    const db = getDB();
    db.execute(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value;',
      [key, String(value)],
    );
    return true;
  } catch (error) {
    handleError(error, 'setSetting');
    return false;
  }
};

// ---------------------------------------------------------------------------
// Typed helpers — keep callers clean
// ---------------------------------------------------------------------------

export const getDefaultPlatform = () =>
  getSetting(SETTINGS_KEYS.DEFAULT_PLATFORM);

export const setDefaultPlatform = (platformId) =>
  setSetting(SETTINGS_KEYS.DEFAULT_PLATFORM, platformId);

/**
 * Returns the user-configured SMS-per-hour throttle. Falls back to 300
 * if not yet set (a conservative default well under typical carrier
 * bulk-SMS thresholds).
 */
export const getSmsPerHourLimit = () => {
  const raw = getSetting(SETTINGS_KEYS.SMS_PER_HOUR_LIMIT);
  if (raw === null || isNaN(Number(raw)) || Number(raw) <= 0) return 300;
  return Number(raw);
};

/**
 * @param {number} limit Positive integer — max SMS sends allowed in any
 *                        rolling 60-minute window.
 */
export const setSmsPerHourLimit = (limit) =>
  setSetting(SETTINGS_KEYS.SMS_PER_HOUR_LIMIT, limit);

/**
 * Pure UI/debug visibility for rate-limit retry-alarms (QueueScreen /
 * dbScan.js can show "next SMS retry at X"). Purely informational — no
 * functional logic (scheduling, resuming, dedup) depends on this value.
 * If it goes stale after a crash, nothing breaks; it just gets
 * overwritten or cleared on the next processQueue() run.
 */
export const setRateLimitRetryVisibility = (platformId, retryAtISO) =>
  setSetting(`${SETTINGS_KEYS.RATE_LIMIT_RETRY_PREFIX}${platformId}`, retryAtISO);

export const clearRateLimitRetryVisibility = (platformId) =>
  setSetting(`${SETTINGS_KEYS.RATE_LIMIT_RETRY_PREFIX}${platformId}`, '');

export const getRateLimitRetryVisibility = (platformId) => {
  const raw = getSetting(`${SETTINGS_KEYS.RATE_LIMIT_RETRY_PREFIX}${platformId}`);
  return raw && raw.length > 0 ? raw : null;
};