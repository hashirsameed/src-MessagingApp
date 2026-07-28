import { getSetting, setSetting } from '../database/settingsDB';

// ─────────────────────────────────────────────────────────────────────────────
// Dev Mode — runtime, DB-persisted flag that unlocks the same dev/test
// features that are normally only visible when `__DEV__` is true (i.e. only
// in a locally-run debug build). This lets QA/support flip dev tools on
// inside an actual release build, without rebuilding, via a toggle in
// Settings (see SettingsScreen.js).
//
// Design notes:
// - Persisted in the existing generic `settings` key-value table (same
//   table/helpers already used for default_platform, sms_per_hour_limit,
//   etc.) — no new table needed.
// - Cached in memory (`_cachedDevModeEnabled`) because `isDevModeOn()` is
//   called from very hot paths (e.g. debugTrace(), which fires on nearly
//   every step of every send). A DB read per call would add real overhead;
//   a single in-memory boolean does not.
// - `__DEV__` still short-circuits to true, so a real local debug build
//   behaves exactly as before even if this flag was never touched.
// ─────────────────────────────────────────────────────────────────────────────

const DEV_MODE_SETTING_KEY = 'dev_mode_enabled';

let _cachedDevModeEnabled = null; // null = not loaded yet

/**
 * Reads the flag from DB and (re)populates the in-memory cache.
 * Call once at app/db startup (see db.js) so the very first isDevModeOn()
 * call anywhere in the app doesn't have to hit the DB itself.
 */
export const loadDevModeCache = () => {
  try {
    const raw = getSetting(DEV_MODE_SETTING_KEY);
    _cachedDevModeEnabled = raw === '1';
  } catch (error) {
    // Fail safe: if settings table isn't readable yet for any reason,
    // default to OFF rather than silently unlocking dev tools.
    _cachedDevModeEnabled = false;
  }
  return _cachedDevModeEnabled;
};

/**
 * Sync, cheap check — safe to call from render functions and hot loops.
 * Lazily loads the cache on first call if app startup hasn't warmed it yet
 * (e.g. hot-reload during development, or a code path that runs before
 * db.js's startup sequence).
 */
export const isDevModeOn = () => {
  if (_cachedDevModeEnabled === null) loadDevModeCache();
  return Boolean(__DEV__) || _cachedDevModeEnabled;
};

/**
 * Flip the flag. Persists to DB immediately and updates the in-memory
 * cache in the same call, so every other isDevModeOn() call in this
 * session (including in other screens) reflects the new value right
 * away — no app restart needed.
 */
export const setDevModeOn = (enabled) => {
  const value = Boolean(enabled);
  setSetting(DEV_MODE_SETTING_KEY, value ? '1' : '0');
  _cachedDevModeEnabled = value;
  return value;
};