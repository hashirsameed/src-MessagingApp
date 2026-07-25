import { NativeModules, Platform } from 'react-native';
import { getRateLimit, getWindowFreeAtMs } from '../database/rateLimitDB';
import { handleError } from './errorHandler';
import { debugTrace, debugTraceError, generateTraceId } from './debugTrace';

const { AlarmModule } = NativeModules;

// Sentinel contactId used to mark this as a generic "retry processQueue()"
// alarm rather than a real per-contact/template reminder. alarmHeadlessTask.js
// checks for this exact value and routes straight to processQueue(),
// bypassing fireScheduledPair()/scheduled_alarms entirely.
export const RATE_LIMIT_RETRY_SENTINEL = '__RATE_LIMIT_RETRY__';

// If the computed retry time is already in the past (race condition between
// computing it and scheduling it), fall back to firing shortly instead of
// scheduling something in the past. Mirrors IMMEDIATE_ALARM_DELAY_MS in
// alarmScheduler.js.
const IMMEDIATE_RETRY_DELAY_MS = 10000;

const isAlarmModuleAvailable = () =>
  Platform.OS === 'android' &&
  AlarmModule &&
  typeof AlarmModule.scheduleExactAlarm === 'function';

// ─────────────────────────────────────────────────────────────────────────────
// Negative-space request code
// alarmScheduler.js's getRequestCode() always returns a value in 0..2^31-1
// (masked with & 0x7fffffff). Any negative requestCode can therefore never
// collide with a real per-contact/template alarm. One retry-alarm per
// platform: re-scheduling with the same platformId reuses the same
// requestCode, so Android's AlarmManager overwrites the pending one instead
// of stacking duplicates.
// ─────────────────────────────────────────────────────────────────────────────
export const getRetryRequestCode = (platformId) => {
  const str = `RATE_LIMIT_RETRY:${platformId}`;
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (Math.imul(h, 31) + str.charCodeAt(i)) | 0;
  }
  return -(Math.abs(h) + 1);
};

/**
 * Arms (or re-arms) a native alarm that fires exactly when this platform's
 * rate-limit window is expected to free up a slot. Deliberately bypasses
 * scheduleAlarm()/upsertScheduledAlarm() — those write to scheduled_alarms,
 * which is FK-constrained to real contacts/templates, and this alarm isn't
 * tied to either.
 *
 * @param {string} platformId
 * @param {number|null} [explicitRetryAfterMs] Optional — a duration in ms
 *   from an authoritative source (e.g. Meta's own `Retry-After` header on a
 *   WhatsApp 429/130429 response). When given, this takes priority over our
 *   own getWindowFreeAtMs() estimate — Meta knows its actual throttle state
 *   better than our local "evenly spaced sends" assumption — and applies
 *   even when no local admin rate-limit row exists for this platform, since
 *   Meta's own limit is the real constraint in that case.
 */
export const scheduleRateLimitRetryAlarm = async (platformId, explicitRetryAfterMs = null) => {
  if (!isAlarmModuleAvailable()) return 'SKIPPED_NATIVE_UNAVAILABLE';

  const traceId = generateTraceId('rateLimitRetry');
  try {
    let retryAtMs = null;
    let source = 'window_estimate';

    if (explicitRetryAfterMs !== null && explicitRetryAfterMs > 0) {
      retryAtMs = Date.now() + explicitRetryAfterMs;
      source = 'explicit_override';
      debugTrace('RateLimitRetryUsingExplicitOverride', { traceId, platformId, explicitRetryAfterMs });
    } else {
      const rateLimit = getRateLimit(platformId);
      if (!rateLimit) {
        // No configured limit and no explicit override — nothing to retry against.
        debugTrace('RateLimitRetrySkip', { traceId, platformId, reason: 'no_rate_limit_configured' });
        return 'SKIPPED_NO_LIMIT';
      }
      retryAtMs = getWindowFreeAtMs(platformId, rateLimit.windowMinutes);
    }

    if (retryAtMs === null || retryAtMs <= Date.now()) {
      retryAtMs = Date.now() + IMMEDIATE_RETRY_DELAY_MS;
    }

    const requestCode = getRetryRequestCode(platformId);

    const result = await AlarmModule.scheduleExactAlarm(
      requestCode,
      RATE_LIMIT_RETRY_SENTINEL,
      platformId,
      retryAtMs,
    );

    debugTrace('RateLimitRetryScheduled', { traceId, platformId, retryAtMs, requestCode, result, source });
    return result;
  } catch (error) {
    debugTraceError('RateLimitRetryCatch', error, { traceId, function: 'scheduleRateLimitRetryAlarm', platformId });
    handleError(error, 'scheduleRateLimitRetryAlarm');
    return 'FAILED_EXCEPTION';
  }
};