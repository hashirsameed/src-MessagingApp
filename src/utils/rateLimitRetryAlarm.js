import { NativeModules, Platform } from 'react-native';
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
 * @param {Set<number>|null} [limitedWindows] Optional — the set of
 *   windowMinutes values (e.g. {15, 60}) that were ACTUALLY at/over their
 *   cap when this platform's lane broke, as determined by isRateLimited()'s
 *   per-tier `limited` flag (see queueProcessor.js).
 * @param {Array<{windowMinutes: number, safeTimeMs: number}>|null} [engineTierSafeTimes]
 *   Optional — per-tier RECOVERY-AWARE safe times precomputed by the
 *   rate-limit engine (rateLimitEngine.calculateNextSafeSendTime's perTier).
 *   When given, the retry is armed for the latest (max) of these instead of
 *   the legacy "oldest send + window" (1-slot-free) estimate. This is what
 *   makes the 50% recovery policy visible to the alarm: after a saturated
 *   tier, we wait until ~half its capacity has returned, not until one slot
 *   frees (which would immediately re-saturate and re-arm). Priority:
 *   explicitRetryAfterMs (Meta) > engineTierSafeTimes > legacy estimate.
 *
 *   FIX — WHY THIS MATTERS: previously, whenever a platform got rate
 *   limited, this function computed getWindowFreeAtMs() for EVERY
 *   configured tier (e.g. 15min, 1hr, AND 24hr for SMS) and took the
 *   latest (max) of all three — even when only the 15-min tier was
 *   actually the thing blocking sends, with the 1hr/24hr tiers nowhere
 *   near their own caps. That meant the retry alarm could fire up to ~24
 *   hours later than necessary for a lane that only needed ~15 minutes to
 *   clear, leaving the app idle far longer than the real constraint
 *   required.
 *
 *   Now, when limitedWindows is provided and non-empty, only THOSE tiers'
 *   free-at times are considered — the retry fires as soon as the
 *   genuinely-blocking tier(s) clear, regardless of how far the others
 *   are from their own caps. When limitedWindows is omitted/null/empty
 *   (e.g. the provider-side WhatsApp 429 path, which isn't driven by our
 *   own tier math at all), behavior falls back to considering every
 *   configured tier, same as before.
 */
export const scheduleRateLimitRetryAlarm = async (platformId, explicitRetryAfterMs = null, limitedWindows = null, engineTierSafeTimes = null) => {
  if (!isAlarmModuleAvailable()) return 'SKIPPED_NATIVE_UNAVAILABLE';

  const traceId = generateTraceId('rateLimitRetry');
  try {
    let retryAtMs = null;
    let source = 'window_estimate';

    if (explicitRetryAfterMs !== null && explicitRetryAfterMs > 0) {
      retryAtMs = Date.now() + explicitRetryAfterMs;
      source = 'explicit_override';
      debugTrace('RateLimitRetryUsingExplicitOverride', { traceId, platformId, explicitRetryAfterMs });
    } else if (engineTierSafeTimes && engineTierSafeTimes.length > 0) {
      // Recovery-aware safe times from the rate-limit engine — the latest of
      // the actually-relevant tiers is when a slot truly frees per the
      // configured recoveryThreshold (NOT the first-freed-slot estimate).
      const relevant = (limitedWindows && limitedWindows.size > 0)
        ? engineTierSafeTimes.filter((t) => limitedWindows.has(t.windowMinutes))
        : engineTierSafeTimes;
      retryAtMs = relevant.reduce((latest, t) => {
        if (t.safeTimeMs == null) return latest;
        return latest === null ? t.safeTimeMs : Math.max(latest, t.safeTimeMs);
      }, null);
      source = 'engine_tier_safe_time';
      debugTrace('RateLimitRetryUsingEngineTierSafeTimes', {
        traceId, platformId,
        tiers: relevant.map((t) => `${t.windowMinutes}min`).join(',') || 'none',
      });
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
