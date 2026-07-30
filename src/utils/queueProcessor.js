import { Platform, NativeModules } from 'react-native';
import {
  claimPendingQueue, markAsSent, markAsFailed, revertToPending,
  revertBatchToPending, getQueueRowById, claimSpecificQueueItem,
} from '../database/messageQueueDB';
import { getAllContacts } from '../database/contactDB';
import { getAllTemplates } from '../database/templateDB';
import { getAllPlatforms } from '../database/platformDB';
import { getRateLimit } from '../database/rateLimitDB';
import { reserveSlot, releaseSlot } from './rateLimitReservation';
import { isRateLimited, validateQueueItem, normalizeDispatchResult } from './queueUtils';
import { scheduleRateLimitRetryAlarm } from './rateLimitRetryAlarm';
import { getDaysUntilExpiry, personalizeMessage } from './templateMatcher';
import { handleError } from './errorHandler';
import { debugTrace, debugTraceError, debugTraceDuration, generateTraceId } from './debugTrace';
import { getAdapter } from '../platforms/registry';
import { requestSmsPermission } from '../platforms/localTextAdapter';
import { isConfigured as hasWhatsAppCredentials } from '../platforms/whatsappAdapter';

const { AlarmModule } = NativeModules;

// ─────────────────────────────────────────────────────────────────────────────
// FIX 1 — processQueue concurrency lock
// Masla: runExpiryCheck, AlarmFiredTask, aur SafetyNetTask teeno ek waqt mein
//         processQueue() call kar sakte hain. Concurrent calls ki apni alag
//         sentInWindow state hoti, isliye rate limit galat count hoti thi.
// Fix:   Module-level _isProcessing flag. Doosri call foran return karti hai.
// ─────────────────────────────────────────────────────────────────────────────
let _isProcessing = false;

const refreshReminderSurfacesIfChanged = (summary) => {
  if (Platform.OS !== 'android') return;
  if (!AlarmModule?.refreshReminderSurfaces) return;
  if (summary.sent === 0 && summary.opened === 0 && summary.failed === 0) return;
  AlarmModule.refreshReminderSurfaces().catch((error) => {
    handleError(error, 'processQueue.refreshReminderSurfaces');
  });
};

export const FIXED_PLATFORMS = [
  { id: 'sms',      name: 'SMS',      url_scheme: 'sms:{phone}?body={message}', platform_type: 'local_text' },
  { id: 'whatsapp', name: 'WhatsApp', url_scheme: '', platform_type: 'managed_remote' },
  { id: 'email',    name: 'Email',    url_scheme: 'mailto:{email}?subject={subject}&body={message}', platform_type: 'local_text' },
  { id: 'gmail',    name: 'Gmail',    url_scheme: 'googlegmail://co?to={email}&subject={subject}&body={message}', platform_type: 'local_text' },
];

// Fallback flat delay when a platform has no configured rate limit at all
// (unchanged from the old single-lane behavior).
const DEFAULT_GAP_MS = { sms: 3500, whatsapp: 1500 };
const DEFAULT_FALLBACK_GAP_MS = 1500;

// Conservative lower bound on the gap between sends, even if the configured
// rate limit's math would allow something faster. SMS goes through Android's
// native telephony stack (SmsManager) — real-device-safe thresholds vary by
// manufacturer/OS version and aren't independently verified here, so this
// stays a deliberately conservative, tunable default rather than an
// aggressive hand-picked number. WhatsApp is a pure network call (Meta Cloud
// API) — no telephony-stack risk, and Meta does its own burst pacing
// server-side — so it gets a much smaller floor.
const SAFETY_FLOOR_MS = { sms: 2000, whatsapp: 800 };

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const dispatchItem = async (platform, contact, message, smsPermissionGranted, waConfigured, traceContext = {}, template = null) => {
  debugTrace('DispatchItemStart', {
    ...traceContext,
    platformId: platform.id,
    contactId: contact.id,
    smsPermissionGranted,
    waConfigured,
  });

  const adapter = getAdapter(platform.platform_type ?? 'local_text');
  return adapter.dispatch(platform, contact, message, { smsPermissionGranted, waConfigured, traceContext, template });
};

// Dynamic, rate-limit-aware pacing: spread sends evenly across the
// configured window instead of a flat delay, so a loose limit (e.g. "100 per
// hour") doesn't waste most of its capacity on an unnecessarily slow flat
// gap, and a tight limit doesn't burn through its budget in seconds. Falls
// back to the old flat default when no rate limit is configured for this
// platform.
const computeMinGapMs = (platformId, rateLimit) => {
  if (!rateLimit) return DEFAULT_GAP_MS[platformId] ?? DEFAULT_FALLBACK_GAP_MS;
  const dynamicGapMs = (rateLimit.windowMinutes * 60 * 1000) / rateLimit.limitCount;
  const floor = SAFETY_FLOOR_MS[platformId] ?? 0;
  return Math.max(floor, dynamicGapMs);
};

/**
 * Processes one platform's claimed items, start to finish, independent of
 * every other platform's lane (see processQueue — lanes run in parallel via
 * Promise.all). Keeps all the original per-item logic (validation,
 * in-flight guard rail, dispatch, mark sent/failed) exactly as before;
 * what's new here is:
 *   - rate-limit check breaks the lane immediately with a single batch
 *     revert instead of looping through every remaining item individually
 *   - pacing uses computeMinGapMs() instead of a flat constant
 *   - dispatch results are normalized: localTextAdapter still returns a
 *     plain string ('sent' | 'opened' | 'failed_<REASON>'), while
 *     whatsappAdapter now returns an object ({ status, ... }) so it can
 *     carry rate-limit metadata (retryAfterMs) — both are normalized to
 *     the same { status, ... } shape here before branching
 */
const processLane = async (platformId, items, ctx) => {
  const {
    contactMap, templateMap, platformMap, smsPermissionGranted, waConfigured,
    traceId, summary, rateLimitedPlatformIds, retryAfterOverrides, onProgress, claimedTotal,
  } = ctx;

  const platform = platformMap.get(platformId);
  const rateLimit = getRateLimit(platformId);
  const minGapMs = computeMinGapMs(platformId, rateLimit);

  debugTrace('ProcessLaneStart', {
    traceId, platformId, itemCount: items.length,
    limitCount: rateLimit?.limitCount ?? 'none', windowMinutes: rateLimit?.windowMinutes ?? 'none',
    minGapMs,
  });

  for (let i = 0; i < items.length; i++) {
    // --- RATE LIMIT CHECK — break the whole lane immediately, batch-revert ---
    // Shared helper isRateLimited() counts DB-sent + in-flight reservations,
    // recomputed fresh each iteration so concurrent processSingleItem calls
    // don't let this lane over-send.
    {
      const { limited: rateLimitedNow } = isRateLimited(platformId, rateLimit);
      if (rateLimitedNow) {
        const remaining = items.slice(i);
        debugTrace('ProcessLaneRateLimitBreak', {
          traceId, platformId, remainingCount: remaining.length,
        });
        revertBatchToPending(remaining.map((r) => r.id), traceId);
        summary.rateLimited += remaining.length;
        rateLimitedPlatformIds.add(platformId);
        break;
      }
    }

    const item = items[i];
    summary.processed += 1;

    const traceContext = {
      traceId, queueId: item.id, contactId: item.contact_id, templateId: item.template_id,
      platformId, queueStatus: item.status, itemIndex: i, itemTotal: items.length,
    };
    const itemStartTime = Date.now();
    debugTrace('ProcessQueueItemStart', traceContext);

    const contact  = contactMap.get(item.contact_id);
    const template = templateMap.get(item.template_id);

    // --- VALIDATION (shared helper) ---
    {
      const validationError = validateQueueItem(item, contact, template, platform);
      if (validationError) {
        debugTrace('ProcessQueueItemValidationFailed', { ...traceContext, exitReason: validationError });
        markAsFailed(item.id, validationError, traceId);
        summary.failed += 1;
        onProgress?.(summary.processed, claimedTotal);
        continue;
      }
    }

    // ========================================================================
    // 🚨 IN-FLIGHT GUARD RAIL (unchanged) — silent skip, no markAsFailed/Sent
    // ========================================================================
    const freshRow = getQueueRowById(item.id);
    if (!freshRow || freshRow.status === 'SUPERSEDED' || freshRow.status === 'CANCELLED' || freshRow.status === 'SENT') {
      debugTrace('ProcessQueueItemInFlightAbort', {
        ...traceContext,
        exitReason: 'in_flight_aborted_by_guard_rail',
        freshStatus: freshRow?.status ?? 'DELETED_VIA_CASCADE',
      });
      continue;
    }
    // ========================================================================

    let brokeLaneOnRateLimit = false;
    const reservationId = rateLimit ? reserveSlot(platformId) : null;

    try {
      const daysLeft = getDaysUntilExpiry(contact.expiry_datetime);
      const message  = personalizeMessage(template.body, contact, daysLeft);
      debugTrace('MessagePersonalized', { ...traceContext, daysLeft, messageLength: message?.length ?? 0 });

      debugTrace('DispatchItemBefore', { ...traceContext, platformId });
      let rawResult;
      try {
        rawResult = await dispatchItem(
          platform, contact, message, smsPermissionGranted, waConfigured, traceContext, template,
        );
      } finally {
        // Release the moment dispatch resolves (or throws) — DB state now
        // reflects reality, no need to keep holding the in-flight slot.
        if (reservationId !== null) releaseSlot(platformId, reservationId);
      }
      debugTrace('DispatchItemAfter', { ...traceContext, rawResult });

      // Normalize outcome via shared helper
      const outcome = normalizeDispatchResult(rawResult);

      if (outcome.status === 'sent') {
        markAsSent(item.id, traceId);
        summary.sent += 1;
        debugTrace('ProcessQueueItemOutcome', { ...traceContext, outcome: 'sent' });
      } else if (outcome.status === 'opened') {
        markAsSent(item.id, traceId);
        summary.opened += 1;
        debugTrace('ProcessQueueItemOutcome', { ...traceContext, outcome: 'opened' });
      } else if (outcome.status === 'rate_limited_WA') {
        // Meta itself is throttling (HTTP 429 / error 130429) — this is
        // temporary, not a permanent failure. Revert this item AND
        // everything else still queued in this lane (retrying them now
        // would just hit the same throttle again), then exit the lane —
        // the retry-alarm (armed below, in processQueue) will pick the
        // whole batch back up once Meta's window clears.
        revertToPending(item.id, traceId);
        const remaining = items.slice(i + 1);
        if (remaining.length > 0) revertBatchToPending(remaining.map((r) => r.id), traceId);
        summary.rateLimited += 1 + remaining.length;
        rateLimitedPlatformIds.add(platformId);
        if (outcome.retryAfterMs) {
          retryAfterOverrides.set(platformId, outcome.retryAfterMs);
        }
        debugTrace('ProcessQueueItemOutcome', {
          ...traceContext, outcome: 'rate_limited', retryAfterMs: outcome.retryAfterMs ?? 'none',
          remainingSkipped: remaining.length,
        });
        brokeLaneOnRateLimit = true;
      } else {
        // 'failed_permanent' (object, from WhatsApp) or legacy
        // 'failed_<REASON>' (string, from localTextAdapter) — both permanent.
        const reason = outcome.reason ?? (outcome.status ?? '').replace('failed_', '').toUpperCase();
        markAsFailed(item.id, reason, traceId);
        summary.failed += 1;
        debugTrace('ProcessQueueItemOutcome', { ...traceContext, outcome: 'failed', failReason: reason });
      }
    } catch (error) {
      debugTraceError('ProcessQueueItemCatch', error, { function: `processQueue.item.${item.id}`, ...traceContext });
      handleError(error, `processQueue.item.${item.id}`);
      markAsFailed(item.id, 'SEND_FAILED_UNKNOWN', traceId);
      summary.failed += 1;
      debugTrace('ProcessQueueItemOutcome', { ...traceContext, outcome: 'failed', failReason: 'SEND_FAILED_UNKNOWN' });
    }

    onProgress?.(summary.processed, claimedTotal);
    debugTraceDuration('ProcessQueueItemEnd', itemStartTime, { ...traceContext, ...summary });

    if (brokeLaneOnRateLimit) break;

    if (i < items.length - 1) {
      debugTrace('ProcessQueueInterItemDelayBefore', { ...traceContext, delayMs: minGapMs });
      await delay(minGapMs);
      debugTrace('ProcessQueueInterItemDelayAfter', { ...traceContext, delayMs: minGapMs });
    }
  }

  debugTrace('ProcessLaneEnd', { traceId, platformId });
};

export const processQueue = async (onProgress, parentTraceId = null) => {
  // FIX 1 — Concurrency guard: agar pehle se chal raha hai to foran return karo
  if (_isProcessing) {
    debugTrace('ProcessQueueSkipped', { reason: 'already_running', parentTraceId: parentTraceId ?? 'none' });
    return { processed: 0, sent: 0, opened: 0, failed: 0, rateLimited: 0, rateLimitedPlatformIds: [] };
  }
  _isProcessing = true;

  const startTime = Date.now();
  const traceId = parentTraceId ?? generateTraceId('processQueue');
  const summary = { processed: 0, sent: 0, opened: 0, failed: 0, rateLimited: 0, rateLimitedPlatformIds: [] };
  debugTrace('ProcessQueueStart', { traceId, parentTraceId: parentTraceId ?? 'none' });

  try {
    debugTrace('ClaimPendingQueueInvokeBefore', { traceId });
    const claimed = claimPendingQueue(traceId);
    debugTrace('ClaimPendingQueueInvokeAfter', { traceId, claimedCount: claimed.length });

    if (claimed.length === 0) {
      debugTraceDuration('ProcessQueueExit', startTime, { traceId, exitReason: 'empty_queue', ...summary });
      return summary;
    }

    debugTrace('LoadBulkDataBefore', { traceId });
    const contacts        = getAllContacts();
    const templates       = getAllTemplates();
    const customPlatforms = getAllPlatforms();
    const allPlatforms    = [...FIXED_PLATFORMS, ...customPlatforms];
    debugTrace('LoadBulkDataAfter', {
      traceId,
      contactCount: contacts.length,
      templateCount: templates.length,
      platformCount: allPlatforms.length,
    });

    const contactMap  = new Map(contacts.map((c) => [c.id, c]));
    const templateMap = new Map(templates.map((t) => [t.id, t]));
    const platformMap = new Map(allPlatforms.map((p) => [p.id, p]));

    let smsPermissionGranted = false;
    if (Platform.OS === 'android') {
      smsPermissionGranted = await requestSmsPermission();
    }

    const waConfigured = await hasWhatsAppCredentials();
    debugTrace('HasWhatsAppCredentialsAfter', { traceId, waConfigured });

    // --- Split the claimed queue into independent per-platform lanes ---
    // SMS and WhatsApp (and any other platform) no longer wait behind each
    // other — each lane paces and rate-limits itself, and all lanes run
    // concurrently via Promise.all below.
    const byPlatform = new Map();
    for (const item of claimed) {
      const pid = item.platform_id;
      if (!byPlatform.has(pid)) byPlatform.set(pid, []);
      byPlatform.get(pid).push(item);
    }
    debugTrace('QueueSplitIntoLanes', {
      traceId,
      lanes: Array.from(byPlatform.entries()).map(([pid, items]) => `${pid}:${items.length}`).join(','),
    });

    // Platforms that hit their limit during this run — used after all lanes
    // finish to arm a precise native retry-alarm per platform (see
    // rateLimitRetryAlarm.js), instead of relying only on the next
    // coincidental alarm/SafetyNetTask/app-foreground run.
    const rateLimitedPlatformIds = new Set();
    // Meta's own Retry-After (ms), captured per-platform when a WhatsApp
    // lane hits a 429/130429 — takes priority over our own window estimate
    // when arming that platform's retry-alarm.
    const retryAfterOverrides = new Map();

    const laneCtx = {
      contactMap, templateMap, platformMap, smsPermissionGranted, waConfigured,
      traceId, summary, rateLimitedPlatformIds, retryAfterOverrides,
      onProgress, claimedTotal: claimed.length,
    };

    await Promise.all(
      Array.from(byPlatform.entries()).map(([platformId, items]) => processLane(platformId, items, laneCtx)),
    );

    if (summary.rateLimited > 0) {
      debugTrace('ProcessQueueRateLimitedSummary', {
        traceId, rateLimitedCount: summary.rateLimited, exitReason: 'deferred_for_next_run',
        platformIds: Array.from(rateLimitedPlatformIds).join(','),
      });

      // Arm one native retry-alarm per affected platform, timed for exactly
      // when a slot frees up (or Meta's own Retry-After, if we have one).
      // Self-perpetuating: whenever this alarm fires, it calls
      // processQueue() again — if that run is still rate-limited, this same
      // block re-arms it (same requestCode, so it overwrites rather than
      // stacking). Runs independently of SafetyNetTask's ~15-min cadence,
      // which stays as a backup in case this alarm is ever missed (reboot,
      // cancellation).
      for (const platformId of rateLimitedPlatformIds) {
        await scheduleRateLimitRetryAlarm(platformId, retryAfterOverrides.get(platformId) ?? null);
      }
    }

    summary.rateLimitedPlatformIds = Array.from(rateLimitedPlatformIds);

    debugTraceDuration('ProcessQueueEnd', startTime, { traceId, outcome: 'completed', ...summary });
    refreshReminderSurfacesIfChanged(summary);
    return summary;
  } catch (error) {
    debugTraceError('ProcessQueueCatch', error, { function: 'processQueue', traceId });
    handleError(error, 'processQueue');
    debugTraceDuration('ProcessQueueEnd', startTime, { traceId, outcome: 'error', ...summary });
    refreshReminderSurfacesIfChanged(summary);
    return summary;
  } finally {
    // FIX 1 — Lock hamesha release karo, chahe error aaye ya na aaye
    _isProcessing = false;
  }
};

/**
 * Process a SINGLE queue item by ID. Used by fireScheduledPair so that
 * one alarm firing only sends its own message, not the entire queue.
 * Reuses the same validation + dispatch logic as processLane.
 */
export const processSingleItem = async (queueId, traceId = null) => {
  const startTime = Date.now();
  const tid = traceId ?? generateTraceId('processSingleItem');
  debugTrace('ProcessSingleItemStart', { traceId: tid, queueId });

  try {
    const item = getQueueRowById(queueId);

    if (!item) {
      debugTrace('ProcessSingleItemNotFound', { traceId: tid, queueId });
      return { sent: 0, failed: 0 };
    }

    // In-flight guard rail
    if (item.status !== 'PENDING' && item.status !== 'CLAIMED') {
      debugTrace('ProcessSingleItemSkipped', { traceId: tid, queueId, status: item.status });
      return { sent: 0, failed: 0 };
    }

    // Claim this specific item
    const claimed = claimSpecificQueueItem(queueId, `single-${tid}`);
    if (!claimed) {
      debugTrace('ProcessSingleItemClaimFailed', { traceId: tid, queueId });
      return { sent: 0, failed: 0 };
    }

    // --- RATE LIMIT CHECK (shared helper) ---
    const rateLimit = getRateLimit(claimed.platform_id);
    let reservationId = null;
    if (rateLimit) {
      const { limited: rateLimitedNow, currentSent } = isRateLimited(claimed.platform_id, rateLimit);
      if (rateLimitedNow) {
        debugTrace('ProcessSingleItemRateLimited', {
          traceId: tid, queueId, platformId: claimed.platform_id,
          currentSent, limitCount: rateLimit.limitCount, windowMinutes: rateLimit.windowMinutes,
        });
        revertToPending(queueId, tid);
        await scheduleRateLimitRetryAlarm(claimed.platform_id);
        return { sent: 0, failed: 0 };
      }
      reservationId = reserveSlot(claimed.platform_id);
    }

    // Load references
    const contacts = getAllContacts();
    const customPlatforms = getAllPlatforms();
    const allPlatforms = [...FIXED_PLATFORMS, ...customPlatforms];
    const templates = getAllTemplates();

    const contactMap  = new Map(contacts.map((c) => [c.id, c]));
    const templateMap = new Map(templates.map((t) => [t.id, t]));
    const platformMap = new Map(allPlatforms.map((p) => [p.id, p]));

    const contact  = contactMap.get(claimed.contact_id);
    const template = templateMap.get(claimed.template_id);
    const platform = platformMap.get(claimed.platform_id);

    // Validation (shared helper)
    const validationError = validateQueueItem(claimed, contact, template, platform);
    if (validationError) {
      debugTrace('ProcessSingleItemValidationFailed', { traceId: tid, queueId, reason: validationError });
      markAsFailed(queueId, validationError, tid);
      return { sent: 0, failed: 1 };
    }

    // Dispatch
    let smsPermissionGranted = false;
    let rawResult;
    let traceContext;
    try {
      if (Platform.OS === 'android') {
        smsPermissionGranted = await requestSmsPermission();
      }
      const waConfigured = await hasWhatsAppCredentials();

      const daysLeft = getDaysUntilExpiry(contact.expiry_datetime);
      const message  = personalizeMessage(template.body, contact, daysLeft);

      traceContext = { traceId: tid, queueId, contactId: contact.id, templateId: template.id, platformId: claimed.platform_id };
      rawResult = await dispatchItem(
        platform, contact, message, smsPermissionGranted, waConfigured, traceContext, template,
      );
    } finally {
      // Release no matter what happens above — a thrown error here would
      // otherwise leak the slot until pruneExpired's window-based cleanup
      // eventually clears it, temporarily under-counting real capacity.
      if (reservationId !== null) releaseSlot(claimed.platform_id, reservationId);
    }

    const outcome = normalizeDispatchResult(rawResult);

    if (outcome.status === 'sent' || outcome.status === 'opened') {
      markAsSent(queueId, tid);
      debugTrace('ProcessSingleItemOutcome', { ...traceContext, outcome: outcome.status });
      refreshReminderSurfacesIfChanged({ sent: 1, opened: 0, failed: 0 });
      return { sent: 1, failed: 0 };
    } else if (outcome.status === 'rate_limited_WA') {
      revertToPending(queueId, tid);
      debugTrace('ProcessSingleItemOutcome', { ...traceContext, outcome: 'rate_limited' });
      if (outcome.retryAfterMs) {
        await scheduleRateLimitRetryAlarm(claimed.platform_id, outcome.retryAfterMs);
      }
      return { sent: 0, failed: 0 };
    } else {
      const reason = outcome.reason ?? (outcome.status ?? '').replace('failed_', '').toUpperCase();
      markAsFailed(queueId, reason, tid);
      debugTrace('ProcessSingleItemOutcome', { ...traceContext, outcome: 'failed', failReason: reason });
      return { sent: 0, failed: 1 };
    }
  } catch (error) {
    debugTraceError('ProcessSingleItemCatch', error, { traceId: tid, queueId });
    handleError(error, `processSingleItem.${queueId}`);
    markAsFailed(queueId, 'SEND_FAILED_UNKNOWN', tid);
    return { sent: 0, failed: 1 };
  }
};