import { Platform, NativeModules } from 'react-native';
import {
  claimPendingQueue, markAsSent, markAsFailed, revertToPending,
  revertBatchToPending, getQueueRowById, claimSpecificQueueItem,
  getPendingCountForPlatform,
} from '../database/messageQueueDB';
import { getAllContacts } from '../database/contactDB';
import { getAllTemplates } from '../database/templateDB';
import { getAllPlatforms } from '../database/platformDB';
import { getSentHistoryForPlatform } from '../database/rateLimitDB';
import { getMinSendIntervalMs, getRateLimitRecoveryThreshold } from '../database/settingsDB';
import {
  reserveSlot, releaseSlot, getInFlightCount,
  getExecutionContext, recordDispatchStart, recordDispatchCompletion,
} from './rateLimitReservation';
import { resolveRateLimits, validateQueueItem, normalizeDispatchResult } from './queueUtils';
import { calculateNextSafeSendTime, pruneHistory, appendSend } from './rateLimitEngine';
import { scheduleRateLimitRetryAlarm } from './rateLimitRetryAlarm';
import { MAX_INLINE_DELAY_MS } from './schedulerConstants';
import { getDaysUntilExpiry, personalizeMessage } from './templateMatcher';
import { handleError } from './errorHandler';
import { debugTrace, debugTraceError, debugTraceDuration, generateTraceId } from './debugTrace';
import { getAdapter } from '../platforms/registry';
import { requestSmsPermission } from '../platforms/localTextAdapter';
import { isConfigured as hasWhatsAppCredentials } from '../platforms/whatsappAdapter';
import { isConfigured as hasBulkSmsCredentials } from '../platforms/bulkSmsAdapter';
import { getNow, devDelayMs } from './devClock';

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

// ─────────────────────────────────────────────────────────────────────────────
// DEV-ONLY dry-run dispatch mode
//
// Lets the Testing Lab exercise the REAL pipeline end-to-end — claim,
// validation, constraint-based schedule calculation, retry-alarm targeting —
// against real DB rows, WITHOUT the
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

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, devDelayMs(ms)));

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
 * The engine is the sole source of the lane decision. When a tier blocks, its
 * recovery-aware safe time is passed to the retry alarm so the lane resumes
 * at the engine-calculated time instead of reimplementing window arithmetic.
 */
const processLane = async (platformId, items, ctx) => {
  const {
    contactMap, templateMap, platformMap, smsPermissionGranted, waConfigured, bulkSmsConfigured,
    traceId, summary, rateLimitedPlatformIds, retryAfterOverrides, limitedWindowsByPlatform,
    historyByPlatform, engineRetryTargetsByPlatform, minSendIntervalMs, recoveryThreshold,
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

  // ─────────────────────────────────────────────────────────────────────────
  // FIX — double-counted rateLimited items across drain passes.
  //
  // Masla: processQueue()'s outer while(keepDraining) loop only stops when
  // an ENTIRE pass makes zero progress. If a pass had SOME successful
  // sends AND some items that hit the rate-limit wall (both in the same
  // claim-batch, same platform), processedThisPass > 0 keeps the loop
  // going — so the very next claimPendingQueue() call re-claims the items
  // THIS SAME CALL just reverted-to-PENDING a moment ago, immediately
  // re-hits the exact same still-active rate limit (no real time has
  // elapsed within one synchronous processQueue() call), and reverts them
  // AGAIN — double-incrementing summary.rateLimited for the same
  // underlying block. Verified via a real-pipeline test: a 6-item batch
  // against a limit of 5 reported rateLimited=2 instead of 1, and a
  // 10-item batch against a limit of 5 reported rateLimited=10 instead of
  // 5 — always exactly 2x, every time a pass mixed sends and blocks.
  //
  // Fix: once a platform has already been recorded as rate-limited earlier
  // in THIS processQueue() call, any later re-claim of its (already
  // reverted) items within the same call is known-redundant — revert them
  // back to PENDING again (harmless, idempotent) but don't count them a
  // second time. This doesn't change what actually gets sent or when
  // (rate-limited items were never going to send in this call either
  // way) — it only corrects the reported counter and skips the wasted
  // isRateLimited() DB round-trip.
  // ─────────────────────────────────────────────────────────────────────────
  if (rateLimitedPlatformIds.has(platformId)) {
    debugTrace('ProcessLaneSkipAlreadyRateLimited', {
      traceId, platformId, itemCount: items.length,
      reason: 'platform_already_rate_limited_this_call_avoiding_double_count',
    });
    revertBatchToPending(items.map((r) => r.id), traceId);
    return;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Rate-limit engine setup for this lane.
  //   history   — hydrate the platform's send history ONCE (persistent source
  //               of truth: message_queue.sent_at), then append incrementally
  //               as sends are accepted. Shared across drain passes via
  //               historyByPlatform.
  //   queueDepth — claimed items (status CLAIMED) + still-PENDING rows = how
  //               many this platform still needs to send; feeds the smooth
  //               pacing layer so a deep backlog spreads instead of bursting.
  // ─────────────────────────────────────────────────────────────────────────
  if (!historyByPlatform.has(platformId)) {
    const maxWindowMs = rateLimits.reduce((m, t) => Math.max(m, t.windowMinutes * 60 * 1000), 0);
    const hydrateAtMs = getNow();
    historyByPlatform.set(
      platformId,
      pruneHistory(getSentHistoryForPlatform(platformId, hydrateAtMs - maxWindowMs), hydrateAtMs, maxWindowMs),
    );
  }
  const history = historyByPlatform.get(platformId);
  let executionContext = getExecutionContext(platformId);
  let pendingCount = getPendingCountForPlatform(platformId);
  // Tiers normalized to ms for the pure engine.
  const engineTiers = rateLimits.map((t) => ({ windowMs: t.windowMinutes * 60 * 1000, limit: t.limitCount }));

  for (let i = 0; i < items.length; i++) {
    // --- RATE-LIMIT / SCHEDULE CHECK — constraint-based safe time ---
    // calculateNextSafeSendTime() = max over EVERY tier of that tier's safe
    // time (sliding-window, ANDed), plus the execution+gap floor and the
    // smooth-pacing floor. When a tier is genuinely saturated and the
    // recovery wait is beyond MAX_INLINE_DELAY_MS, the whole lane
    // batch-reverts and a retry alarm is armed for exactly when a tier frees
    // (recovery-aware, spec §12/§13). Otherwise the delay is inline pacing
    // (a few seconds) and we proceed.
    // Refresh pendingCount BEFORE computing queueDepth so newly-arrived
    // PENDING rows immediately influence THIS send's pacing calculation
    // (spec §3) — previously this was refreshed after queueDepth was
    // already computed, so a queue-growth event only took effect starting
    // the following item instead of the very next scheduling decision.
    pendingCount = getPendingCountForPlatform(platformId);
    const queueDepth = items.length - i + pendingCount;
    // Refresh execution context live before every scheduling decision so the
    // engine's execution-floor and pacing anchors reflect the most recent
    // completed dispatch (recordDispatchCompletion updates the module-level
    // ledger). Previously this was read once per lane, allowing a burst when
    // recordDispatchCompletion updated the module state but the local
    // variable stayed stale.
    executionContext = getExecutionContext(platformId);
    const nowMs = getNow();
    const inFlightByWindow = {};
    rateLimits.forEach((t) => {
      inFlightByWindow[t.windowMinutes * 60 * 1000] = getInFlightCount(platformId, t.windowMinutes);
    });
    const decision = calculateNextSafeSendTime({
      platformId, now: nowMs, queueDepth, tiers: engineTiers, history,
      inFlightByWindow, executionContext, minSendIntervalMs, recoveryThreshold,
    });
    const delayMs = decision.safeTimeMs - nowMs;

    if (decision.reason === 'saturated_recovery' && delayMs > MAX_INLINE_DELAY_MS) {
      const remaining = items.slice(i);
      debugTrace('ProcessLaneRateLimitBreak', {
        traceId, platformId, remainingCount: remaining.length,
        nextSafeTimeMs: decision.safeTimeMs, delayMs,
        limitedTiers: decision.perTier.filter((p) => p.safeTimeMs > nowMs).map((p) => `${Math.round(p.windowMs / 60000)}min`).join(','),
      });
      revertBatchToPending(remaining.map((r) => r.id), traceId);
      summary.rateLimited += remaining.length;
      rateLimitedPlatformIds.add(platformId);
      // Only the tier(s) actually still blocked drive the retry timer — the
      // engine's recovery-aware per-tier safe times (see rateLimitRetryAlarm).
      const blockingSet = new Set(
        decision.perTier.filter((p) => p.safeTimeMs > nowMs).map((p) => Math.round(p.windowMs / 60000)),
      );
      if (blockingSet.size === 0 && decision.selectedTier) {
        blockingSet.add(Math.round(decision.selectedTier.windowMs / 60000));
      }
      limitedWindowsByPlatform.set(platformId, blockingSet);
      engineRetryTargetsByPlatform.set(
        platformId,
        decision.perTier.map((p) => ({ windowMinutes: Math.round(p.windowMs / 60000), safeTimeMs: p.safeTimeMs })),
      );
      break;
    }

    // Observability (spec §22) — why THIS send was scheduled for its time.
    const selectedPerTier = decision.selectedTier
      ? decision.perTier.find((p) => p.windowMs === decision.selectedTier.windowMs)
      : null;
    debugTrace('RateLimitScheduleDecision', {
      traceId, messageId: items[i].id, platformId,
      currentTimeMs: nowMs, queueSize: queueDepth,
      nextSendTimeMs: decision.safeTimeMs, delayMs,
      selectedConstraint: decision.reason,
      tierWindowMs: decision.selectedTier?.windowMs ?? null,
      tierLimit: decision.selectedTier?.limit ?? null,
      tierCount: selectedPerTier?.count ?? null,
      remainingCapacity: selectedPerTier?.remainingCapacity ?? null,
      oldestTimestampMs: selectedPerTier?.oldestTimestampMs ?? null,
      executionDurationMs:
        executionContext.lastActualStartMs != null && executionContext.lastActualCompletionMs != null
          ? executionContext.lastActualCompletionMs - executionContext.lastActualStartMs
          : null,
      reasonForDelay: decision.reason,
    });

    const item = items[i];
    summary.processed += 1;

    const traceContext = {
      traceId, queueId: item.id, contactId: item.contact_id, templateId: item.template_id,
      platformId, queueStatus: item.status, itemIndex: i, itemTotal: items.length,
    };
    const itemStartTime = Date.now(); // real wall-clock — debug perf timing only, not scheduling
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
    // ATOMIC check-and-reserve (R1): the engine decision above and this
    // reservation are in the same synchronous block (no await between), so a
    // concurrent worker can't interleave and double-book the last slot. The
    // reservation is HELD across the inline delay so a concurrent worker can't
    // refill the slot while we wait.
    const reservationId = reserveSlot(platformId);
    if (delayMs > 0) {
      debugTrace('ProcessQueueInlineDelayBefore', { ...traceContext, delayMs });
      await delay(delayMs);
      debugTrace('ProcessQueueInlineDelayAfter', { ...traceContext, delayMs });
    }

    try {
      const daysLeft = getDaysUntilExpiry(contact.expiry_datetime);
      const message  = personalizeMessage(template.body, contact, daysLeft);
      debugTrace('MessagePersonalized', { ...traceContext, daysLeft, messageLength: message?.length ?? 0 });

      debugTrace('DispatchItemBefore', { ...traceContext, platformId });
      let rawResult;
      const actualStart = getNow();
      recordDispatchStart(platformId, actualStart);
      try {
        rawResult = await dispatchItem(
          platform, contact, message, smsPermissionGranted, waConfigured, bulkSmsConfigured, traceContext, template,
        );
      } finally {
        // Release the moment dispatch resolves (or throws) — DB state now
        // reflects reality, no need to keep holding the in-flight slot.
        releaseSlot(platformId, reservationId);
        // Execution + gap (CONFIRMED BEHAVIOR 1): the next send may only
        // start minSendIntervalMs AFTER this dispatch completes.
        recordDispatchCompletion(platformId, getNow());
      }
      debugTrace('DispatchItemAfter', { ...traceContext, rawResult });

      // Normalize outcome via shared helper
      const outcome = normalizeDispatchResult(rawResult);

      if (outcome.status === 'sent' || outcome.status === 'opened') {
        // Accepted by the provider — this is the moment that consumes
        // rate-limit capacity. Record the ACTUAL send start timestamp into
        // the engine's history (never a scheduled/reserved/failed send).
        appendSend(history, actualStart);
        markAsSent(item.id, traceId, actualStart);
        if (outcome.status === 'sent') summary.sent += 1;
        else summary.opened += 1;
        debugTrace('ProcessQueueItemOutcome', { ...traceContext, outcome: outcome.status });
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
    // No post-dispatch recompute: the next iteration's calculateNextSafeSendTime
    // call reads the freshly-appended history + execution context.
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

  const startTime = Date.now(); // real wall-clock — debug perf timing only, not scheduling
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
    // Rate-limit engine config + per-platform state for THIS run. Config is
    // re-read from settings every run, so a recovery-threshold or
    // min-send-interval change applies to the very next run — no stale
    // schedule to cancel (spec §15).
    //   historyByPlatform       — hydrated once per platform, appended as sends
    //                             are accepted (source of truth: message_queue.sent_at)
    //   engineRetryTargetsByPlatform — recovery-aware per-tier safe times used
    //                             to arm each retry alarm precisely
    // ───────────────────────────────────────────────────────────────────────
    const minSendIntervalMs = getMinSendIntervalMs();
    const recoveryThreshold = getRateLimitRecoveryThreshold();
    const historyByPlatform = new Map();
    const engineRetryTargetsByPlatform = new Map();

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
        historyByPlatform, engineRetryTargetsByPlatform, minSendIntervalMs, recoveryThreshold,
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
          engineRetryTargetsByPlatform.get(platformId) ?? null,
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
  const tid = traceId ?? generateTraceId('processSingleItem');
  debugTrace('ProcessSingleItemStart', { traceId: tid, queueId });

  const minSendIntervalMs = getMinSendIntervalMs();
  const recoveryThreshold = getRateLimitRecoveryThreshold();

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

    // --- RATE-LIMIT / SCHEDULE CHECK (constraint-based, same engine as
    // processLane) — max over EVERY tier of its safe time, plus execution+gap
    // and pacing. Far-off (saturated tier, recovery wait) → revert + arm a
    // recovery-aware retry alarm. Near → reserve, wait inline, dispatch.
    const rateLimits = resolveRateLimits(claimed.platform_id);
    const maxWindowMs = rateLimits.reduce((m, t) => Math.max(m, t.windowMinutes * 60 * 1000), 0);
    const history = pruneHistory(
      getSentHistoryForPlatform(claimed.platform_id, getNow() - maxWindowMs),
      getNow(),
      maxWindowMs,
    );
    const executionContext = getExecutionContext(claimed.platform_id);
    const queueDepth = 1 + getPendingCountForPlatform(claimed.platform_id);
    const engineTiers = rateLimits.map((t) => ({ windowMs: t.windowMinutes * 60 * 1000, limit: t.limitCount }));
    const nowMs = getNow();
    const inFlightByWindow = {};
    rateLimits.forEach((t) => {
      inFlightByWindow[t.windowMinutes * 60 * 1000] = getInFlightCount(claimed.platform_id, t.windowMinutes);
    });
    const decision = calculateNextSafeSendTime({
      platformId: claimed.platform_id, now: nowMs, queueDepth, tiers: engineTiers, history,
      inFlightByWindow, executionContext, minSendIntervalMs, recoveryThreshold,
    });
    const delayMs = decision.safeTimeMs - nowMs;
    let reservationId = null;
    if (decision.reason === 'saturated_recovery' && delayMs > MAX_INLINE_DELAY_MS) {
      debugTrace('ProcessSingleItemRateLimited', {
        traceId: tid, queueId, platformId: claimed.platform_id,
        nextSafeTimeMs: decision.safeTimeMs, delayMs, reason: decision.reason,
        tiers: decision.perTier.map((t) => `${t.count}/${t.limit} per ${Math.round(t.windowMs / 60000)}min`).join(', '),
      });
      revertToPending(queueId, tid);
      // FIX 3 — only the tier(s) actually still blocked drive the retry timer.
      const blockingSet = new Set(
        decision.perTier.filter((p) => p.safeTimeMs > nowMs).map((p) => Math.round(p.windowMs / 60000)),
      );
      const engineTierSafeTimes = decision.perTier.map((p) => ({ windowMinutes: Math.round(p.windowMs / 60000), safeTimeMs: p.safeTimeMs }));
      await scheduleRateLimitRetryAlarm(claimed.platform_id, null, blockingSet.size ? blockingSet : null, engineTierSafeTimes);
      return { sent: 0, failed: 0 };
    }
    // ATOMIC check-and-reserve: decision + reserve in the same sync block.
    reservationId = reserveSlot(claimed.platform_id);
    if (delayMs > 0) await delay(delayMs);

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
    let actualStart = null;
    try {
      if (Platform.OS === 'android') {
        smsPermissionGranted = await requestSmsPermission();
      }
      const waConfigured = await hasWhatsAppCredentials();
      const bulkSmsConfigured = await hasBulkSmsCredentials();

      const daysLeft = getDaysUntilExpiry(contact.expiry_datetime);
      const message  = personalizeMessage(template.body, contact, daysLeft);

      traceContext = { traceId: tid, queueId, contactId: contact.id, templateId: template.id, platformId: claimed.platform_id };
      actualStart = getNow();
      recordDispatchStart(claimed.platform_id, actualStart);
      rawResult = await dispatchItem(
        platform, contact, message, smsPermissionGranted, waConfigured, bulkSmsConfigured, traceContext, template,
      );
    } finally {
      // Release no matter what happens above — a thrown error here would
      // otherwise leak the slot until pruneExpired's window-based cleanup
      // eventually clears it, temporarily under-counting real capacity.
      if (reservationId !== null) releaseSlot(claimed.platform_id, reservationId);
      // Execution + gap (CONFIRMED BEHAVIOR 1).
      recordDispatchCompletion(claimed.platform_id, getNow());
    }

    const outcome = normalizeDispatchResult(rawResult);

    if (outcome.status === 'sent' || outcome.status === 'opened') {
      // Accepted by the provider — consumes rate-limit capacity.
      if (actualStart !== null) appendSend(history, actualStart);
      markAsSent(queueId, tid, actualStart);
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