import { getDB } from './db';
import { handleError } from '../utils/errorHandler';

export const SETTINGS_KEYS = {
  DEFAULT_PLATFORM: 'default_platform', // 'sms' | 'whatsapp' | 'email' | 'gmail' | null
  SMS_PER_HOUR_LIMIT: 'sms_per_hour_limit', // number stored as string, e.g. '300'
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