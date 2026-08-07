import { Platform, NativeModules } from 'react-native';
import {
  claimPendingQueue, markAsSent, markAsFailed, revertToPending,
  revertBatchToPending, getQueueRowById, claimSpecificQueueItem,
} from '../database/messageQueueDB';
import { getAllContacts } from '../database/contactDB';
import { getAllTemplates } from '../database/templateDB';
import { getAllPlatforms } from '../database/platformDB';
import { reserveSlot, releaseSlot } from './rateLimitReservation';
import { isRateLimited, resolveRateLimits, validateQueueItem, normalizeDispatchResult } from './queueUtils';
import { scheduleRateLimitRetryAlarm } from './rateLimitRetryAlarm';
import { getDaysUntilExpiry, personalizeMessage } from './templateMatcher';
import { handleError } from './errorHandler';
import { debugTrace, debugTraceError, debugTraceDuration, generateTraceId } from './debugTrace';
import { getAdapter } from '../platforms/registry';
import { requestSmsPermission } from '../platforms/localTextAdapter';
import { isConfigured as hasWhatsAppCredentials } from '../platforms/whatsappAdapter';
import { isConfigured as hasBulkSmsCredentials } from '../platforms/bulkSmsAdapter';

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

// ─────────────────────────────────────────────────────────────────────────────
// FIX 2 — Continuous-curve pacing (replaces flat "always-sustained-rate" gap)
//
// OLD BEHAVIOR: computeMinGapMs() was called ONCE before the loop, using
// each tier's full-window-average gap (window / limit) regardless of how
// much of that tier's budget was actually used. This meant a platform sat
// at ~115s/message (750/24hr's sustained rate) from the very first send of
// the day, even with 0 messages sent so far — needlessly slow when there
// was no real pressure on any tier yet.
//
// NEW BEHAVIOR: gap is recomputed before EVERY send, from that moment's
// actual currentSent/limitCount ratio per tier. Far from a tier's cap, the
// gap is just the safety floor (fast). As usage approaches that tier's
// cap, the gap ramps up smoothly toward the tier's full sustained gap —
// no fixed "zone" cliff-edge, just a continuous curve. THROTTLE_CURVE_POWER
// controls how "back-loaded" the ramp is: higher values stay flat for
// longer, then rise sharply only in the last stretch before the cap.
//
//   usageRatio = currentSent / limitCount              (0..1)
//   gap = floor + (sustainedGap - floor) * usageRatio^THROTTLE_CURVE_POWER
//
// At power=4: ~20% usage -> gap barely above floor. ~50% -> still mostly
// floor. ~80%+ -> gap climbs quickly toward the full sustained rate, so by
// the time isRateLimited()'s hard gate actually blocks (currentSent >=
// limitCount), pacing has already smoothly decelerated into that wall
// instead of slamming from floor-speed straight into a hard stop.
//
// As before, when multiple tiers are active, the tier demanding the
// LARGEST gap wins — every tier must be respected simultaneously.
// ─────────────────────────────────────────────────────────────────────────────
const THROTTLE_CURVE_POWER = 4;

const computeMinGapMs = (platformId, rateLimits, tierUsage = []) => {
  const tiers = rateLimits ?? [];
  if (tiers.length === 0) return DEFAULT_GAP_MS[platformId] ?? DEFAULT_FALLBACK_GAP_MS;

  const floor = SAFETY_FLOOR_MS[platformId] ?? 0;

  const tightestGapMs = tiers.reduce((maxGap, tier) => {
    const usage = tierUsage.find((u) => u.windowMinutes === tier.windowMinutes);
    const currentSent = usage?.currentSent ?? 0;
    // Clamp to 1 — isRateLimited() already hard-blocks at/over the cap, so
    // this only ever needs to describe the approach toward it.
    const usageRatio = Math.min(1, tier.limitCount > 0 ? currentSent / tier.limitCount : 0);

    const sustainedGapMs = (tier.windowMinutes * 60 * 1000) / tier.limitCount;
    const dynamicGapMs = floor + (sustainedGapMs - floor) * Math.pow(usageRatio, THROTTLE_CURVE_POWER);
    return Math.max(maxGap, dynamicGapMs);
  }, 0);

  return Math.max(floor, tightestGapMs);
};

// ─────────────────────────────────────────────────────────────────────────────
// DEV-ONLY dry-run dispatch mode
//
// Lets the Testing Lab exercise the REAL pipeline end-to-end — claim,
// validation, per-tier rate-limit check, the actual computeMinGapMs()
// pacing curve, retry-alarm targeting — against real DB rows, WITHOUT the
// final step (actual SmsManager/WhatsApp API/bulk-gateway call) ever
// touching a real SIM, network account, or phone number. Only that last
// hop is swapped for a simulated success; everything before it is
// unmodified production logic.
//
// Hard-gated behind __DEV__ at the setter itself, not just at the call
// site — setDevDryRunMode() is a no-op in a release build no matter who
// calls it, so this can never accidentally suppress real sends in
// production even if some code path called it by mistake.
// ─────────────────────────────────────────────────────────────────────────────
let _devDryRunEnabled = false;

export const setDevDryRunMode = (enabled) => {
  if (!__DEV__) return;
  _devDryRunEnabled = !!enabled;
};

export const isDevDryRunMode = () => __DEV__ && _devDryRunEnabled;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const dispatchItem = async (platform, contact, message, smsPermissionGranted, waConfigured, bulkSmsConfigured, traceContext = {}, template = null) => {
  debugTrace('DispatchItemStart', {
    ...traceContext,
    platformId: platform.id,
    contactId: contact.id,
    smsPermissionGranted,
    waConfigured,
    bulkSmsConfigured,
    devDryRun: isDevDryRunMode(),
  });

  if (isDevDryRunMode()) {
    // Simulated success — SAME shape localTextAdapter's real dispatch
    // returns on success ('sent'), so normalizeDispatchResult() and every
    // downstream branch in processLane()/processSingleItem() behave
    // identically to a real send. No SmsModule/fetch/Linking call happens.
    debugTrace('DispatchItemDryRunSimulated', { ...traceContext, platformId: platform.id, contactId: contact.id });
    return 'sent';
  }

  const adapter = getAdapter(platform.platform_type ?? 'local_text');
  return adapter.dispatch(platform, contact, message, { smsPermissionGranted, waConfigured, bulkSmsConfigured, traceContext, template });
};

/**
 * Processes one platform's claimed items, start to finish, independent of
 * every other platform's lane (see processQueue — lanes run in parallel via
 * Promise.all).
 *
 * FIX 2 detail: the rate-limit check at the top of each iteration already
 * calls isRateLimited() to decide whether to break the lane — that same
 * call's per-tier `currentSent` figures are now also what computeMinGapMs()
 * uses for pacing, recomputed fresh after every dispatch instead of once
 * up front. When a break happens, the set of tiers that were ACTUALLY at
 * their cap (not just configured) is captured and threaded through to
 * scheduleRateLimitRetryAlarm() at the end of processQueue, so the retry
 * timer is driven by whichever tier is really blocking, not the loosest
 * (or tightest) of the three by coincidence.
 */
const processLane = async (platformId, items, ctx) => {
  const {
    contactMap, templateMap, platformMap, smsPermissionGranted, waConfigured, bulkSmsConfigured,
    traceId, summary, rateLimitedPlatformIds, retryAfterOverrides, limitedWindowsByPlatform,
    onProgress, claimedTotal,
  } = ctx;

  const platform = platformMap.get(platformId);
  const rateLimits = resolveRateLimits(platformId);

  debugTrace('ProcessLaneStart', {
    traceId, platformId, itemCount: items.length,
    tiers: rateLimits.length > 0
      ? rateLimits.map((t) => `${t.limitCount}/${t.windowMinutes}min`).join(', ')
      : 'none',
  });

  for (let i = 0; i < items.length; i++) {
    // --- RATE LIMIT CHECK — break the whole lane immediately, batch-revert ---
    // Shared helper isRateLimited() counts DB-sent + in-flight reservations,
    // recomputed fresh each iteration so concurrent processSingleItem calls
    // don't let this lane over-send. Its per-tier breakdown is reused below
    // both for pacing (if we don't break) and for the retry-alarm target
    // (if we do).
    const { limited: rateLimitedNow, tiers: tierUsage } = isRateLimited(platformId, rateLimits);
    if (rateLimitedNow) {
      const remaining = items.slice(i);
      debugTrace('ProcessLaneRateLimitBreak', {
        traceId, platformId, remainingCount: remaining.length,
        limitedTiers: tierUsage.filter((t) => t.limited).map((t) => `${t.windowMinutes}min`).join(','),
      });
      revertBatchToPending(remaining.map((r) => r.id), traceId);
      summary.rateLimited += remaining.length;
      rateLimitedPlatformIds.add(platformId);
      // Only the tier(s) actually at/over cap right now should drive the
      // retry timer — see rateLimitRetryAlarm.js for why using every
      // configured tier's free-at (including ones nowhere near their cap)
      // was scheduling retries far later than necessary.
      const limitedSet = new Set(tierUsage.filter((t) => t.limited).map((t) => t.windowMinutes));
      limitedWindowsByPlatform.set(platformId, limitedSet);
      break;
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
    const reservationId = rateLimits.length > 0 ? reserveSlot(platformId) : null;

    try {
      const daysLeft = getDaysUntilExpiry(contact.expiry_datetime);
      const message  = personalizeMessage(template.body, contact, daysLeft);
      debugTrace('MessagePersonalized', { ...traceContext, daysLeft, messageLength: message?.length ?? 0 });

      debugTrace('DispatchItemBefore', { ...traceContext, platformId });
      let rawResult;
      try {
        rawResult = await dispatchItem(
          platform, contact, message, smsPermissionGranted, waConfigured, bulkSmsConfigured, traceContext, template,
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
        // Not a local-tier cap — this is a provider-side throttle, so there's
        // no "limited tier" of ours to report. Leaving this platform absent
        // from limitedWindowsByPlatform means scheduleRateLimitRetryAlarm
        // falls back to explicitRetryAfterMs (set above) or, absent that,
        // every configured tier — same as before for this path.
        debugTrace('ProcessQueueItemOutcome', {
          ...traceContext, outcome: 'rate_limited', retryAfterMs: outcome.retryAfterMs ?? 'none',
          remainingSkipped: remaining.length,
        });
        brokeLaneOnRateLimit = true;
      } else {
        // 'failed_permanent' (object, from WhatsApp/Bulk) or legacy
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
      // Recompute AFTER this dispatch — the send that just happened may
      // have pushed a tier's currentSent up, which should be reflected in
      // the gap before the NEXT item, not the gap that preceded this one.
      const { tiers: tierUsageAfterDispatch } = isRateLimited(platformId, rateLimits);
      const minGapMs = computeMinGapMs(platformId, rateLimits, tierUsageAfterDispatch);
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

    const bulkSmsConfigured = await hasBulkSmsCredentials();
    debugTrace('HasBulkSmsCredentialsAfter', { traceId, bulkSmsConfigured });

    // Platforms that hit their limit during this run — used after all lanes
    // finish to arm a precise native retry-alarm per platform (see
    // rateLimitRetryAlarm.js), instead of relying only on the next
    // coincidental alarm/SafetyNetTask/app-foreground run.
    const rateLimitedPlatformIds = new Set();
    // Meta's own Retry-After (ms), captured per-platform when a WhatsApp
    // lane hits a 429/130429 — takes priority over our own window estimate
    // when arming that platform's retry-alarm.
    const retryAfterOverrides = new Map();
    // FIX 3 — which tier(s) were ACTUALLY at/over their cap when a
    // platform's lane broke, keyed by platformId -> Set<windowMinutes>.
    // Passed to scheduleRateLimitRetryAlarm so it only waits on the
    // tier(s) really blocking, not every configured tier for that
    // platform (see rateLimitRetryAlarm.js).
    const limitedWindowsByPlatform = new Map();

    // ───────────────────────────────────────────────────────────────────────
    // FIX 4 — Drain the whole queue in one call, not just one claim-batch.
    //
    // claimPendingQueue() only claims a bounded batch at a time (a DB/memory
    // safety cap, unrelated to rate limiting). Previously, processQueue()
    // claimed ONE such batch, processed it, and returned — so testing with
    // more items than that batch size required repeatedly re-invoking
    // processQueue() by hand (e.g. re-pressing "Process Queue" in the dev
    // screen) to see the rest, which breaks up the pacing behavior you're
    // trying to observe continuously.
    //
    // Now: keep re-claiming and processing batches in a loop, in the SAME
    // call, until either (a) the queue is empty, or (b) an entire pass makes
    // zero forward progress (every lane hit its rate limit before a single
    // item could even start processing) — at which point further claiming
    // would just re-claim and immediately re-revert the same still-blocked
    // items, so we stop and let the retry-alarm(s) armed below pick it back
    // up once real capacity frees. Items that fail validation or dispatch
    // still count as "progress" (they're processed, just not sent), so the
    // loop only stops on a genuine rate-limit wall, not on failures.
    // ───────────────────────────────────────────────────────────────────────
    let claimedTotalSoFar = 0;
    let keepDraining = true;

    while (keepDraining) {
      debugTrace('ClaimPendingQueueInvokeBefore', { traceId, claimedTotalSoFar });
      const claimed = claimPendingQueue(traceId);
      debugTrace('ClaimPendingQueueInvokeAfter', { traceId, claimedCount: claimed.length });

      if (claimed.length === 0) {
        debugTrace('ProcessQueueDrainComplete', { traceId, reason: 'queue_empty', claimedTotalSoFar });
        break;
      }
      claimedTotalSoFar += claimed.length;

      // --- Split this batch into independent per-platform lanes ---
      // SMS and WhatsApp (and any other platform) don't wait behind each
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

      const laneCtx = {
        contactMap, templateMap, platformMap, smsPermissionGranted, waConfigured, bulkSmsConfigured,
        traceId, summary, rateLimitedPlatformIds, retryAfterOverrides, limitedWindowsByPlatform,
        onProgress, claimedTotal: claimedTotalSoFar,
      };

      const processedBeforePass = summary.processed;

      await Promise.all(
        Array.from(byPlatform.entries()).map(([platformId, items]) => processLane(platformId, items, laneCtx)),
      );

      const processedThisPass = summary.processed - processedBeforePass;
      debugTrace('ProcessQueueDrainPassEnd', {
        traceId, claimedTotalSoFar, processedThisPass, runningSummary: { ...summary },
      });

      if (processedThisPass === 0) {
        // Every lane that had items broke immediately on isRateLimited()
        // before a single item made it past that gate — genuinely blocked,
        // not just "this batch happened to fail." Stop draining.
        debugTrace('ProcessQueueDrainComplete', { traceId, reason: 'no_progress_rate_limited', claimedTotalSoFar });
        keepDraining = false;
      }
    }

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
        await scheduleRateLimitRetryAlarm(
          platformId,
          retryAfterOverrides.get(platformId) ?? null,
          limitedWindowsByPlatform.get(platformId) ?? null,
        );
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
    const rateLimits = resolveRateLimits(claimed.platform_id);
    let reservationId = null;
    if (rateLimits.length > 0) {
      const { limited: rateLimitedNow, currentSent, tiers } = isRateLimited(claimed.platform_id, rateLimits);
      if (rateLimitedNow) {
        debugTrace('ProcessSingleItemRateLimited', {
          traceId: tid, queueId, platformId: claimed.platform_id,
          currentSent, tiers: tiers.map((t) => `${t.currentSent}/${t.limitCount} per ${t.windowMinutes}min${t.limited ? ' (BLOCKED)' : ''}`).join(', '),
        });
        revertToPending(queueId, tid);
        // FIX 3 — only the tier(s) actually at cap, same as processLane.
        const limitedSet = new Set(tiers.filter((t) => t.limited).map((t) => t.windowMinutes));
        await scheduleRateLimitRetryAlarm(claimed.platform_id, null, limitedSet);
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
      const bulkSmsConfigured = await hasBulkSmsCredentials();

      const daysLeft = getDaysUntilExpiry(contact.expiry_datetime);
      const message  = personalizeMessage(template.body, contact, daysLeft);

      traceContext = { traceId: tid, queueId, contactId: contact.id, templateId: template.id, platformId: claimed.platform_id };
      rawResult = await dispatchItem(
        platform, contact, message, smsPermissionGranted, waConfigured, bulkSmsConfigured, traceContext, template,
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