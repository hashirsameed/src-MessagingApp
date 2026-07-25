import { fireScheduledPair } from './alarmFireCore';
import { scanDatabase } from './dbScan';
import { recordEngineRun } from '../database/engineStatusDB';
import { rearmAllScheduledAlarmsAfterBoot, scheduleAlarmsForContact } from './alarmScheduler';
import { processQueue } from './queueProcessor';
import { RATE_LIMIT_RETRY_SENTINEL } from './rateLimitRetryAlarm';
import { getAllContacts } from '../database/contactDB';
import { getActiveTemplates } from '../database/templateDB';
import { getDB } from '../database/db';
import { handleError } from './errorHandler';
import { debugTrace, debugTraceError, debugTraceDuration, generateTraceId } from './debugTrace';

// ─────────────────────────────────────────────────────────────────────────────
// FIX 7 — SafetyNetTask distributed lock (DB-based)
// Masla: Android WorkManager rare cases mein ek hi SafetyNetTask ke do instances
//         chala sakta hai. fireScheduledPair() ka CAS guard correctness protect
//         karta hai lekin dono instances poora scan + kaam karte hain — waste.
// Fix:   settings table mein 'safetynet_lock' row ko DB-level lock ki tarah use
//         karo. UPDATE sirf tab succeed karti hai jab lock NULL ho ya 10 minute
//         se pehle set hua ho (stale lock ko yani app crash ke baad).
//         rowsAffected === 0 matlab doosra instance pehle se chal raha hai.
// ─────────────────────────────────────────────────────────────────────────────
const SAFETY_NET_LOCK_TIMEOUT_MINUTES = 10;

const acquireSafetyNetLock = (traceId) => {
  try {
    const db = getDB();
    const result = db.execute(
      `UPDATE settings
       SET value = datetime('now'), updated_at = datetime('now')
       WHERE key = 'safetynet_lock'
         AND (value IS NULL OR datetime(value) < datetime('now', '-${SAFETY_NET_LOCK_TIMEOUT_MINUTES} minutes'));`,
    );
    const acquired = (result?.rowsAffected ?? 0) > 0;
    debugTrace('SafetyNetLockAcquire', { traceId, acquired });
    return acquired;
  } catch (error) {
    handleError(error, 'acquireSafetyNetLock');
    // Lock acquire fail hua — safe side pe rehte hain, assume nahi kiya keh acquired hai
    return false;
  }
};

const releaseSafetyNetLock = (traceId) => {
  try {
    const db = getDB();
    db.execute(
      `UPDATE settings SET value = NULL, updated_at = datetime('now') WHERE key = 'safetynet_lock';`,
    );
    debugTrace('SafetyNetLockRelease', { traceId });
  } catch (error) {
    handleError(error, 'releaseSafetyNetLock');
    // Lock release fail — koi badi baat nahi, timeout se automatically free hoga
  }
};

/**
 * AlarmFiredTask — thin wrapper. All the actual claim/validate/queue logic
 * lives in alarmFireCore.fireScheduledPair(), shared with SafetyNetTask and
 * the boot-time missed-alarm recovery in alarmScheduler.js. Keeping one
 * shared core is what prevents the "dual paths, different rules" bug class.
 */
export const AlarmFiredTask = async (data) => {
  const { contactId, templateId } = data ?? {};
  const traceId = generateTraceId('alarmFired');
  debugTrace('AlarmFiredTaskStart', { traceId, contactId, templateId, source: 'exact_alarm' });

  // Rate-limit retry alarm (see rateLimitRetryAlarm.js) — not a real
  // contact/template pair, so skip fireScheduledPair()/scheduled_alarms
  // entirely and go straight to flushing the queue. If that run is still
  // rate-limited for this platform, processQueue() re-arms this same
  // alarm itself (self-perpetuating loop) — nothing further needed here.
  if (contactId === RATE_LIMIT_RETRY_SENTINEL) {
    debugTrace('AlarmFiredTaskRateLimitRetry', { traceId, platformId: templateId });
    await processQueue(undefined, traceId);
    return;
  }

  await fireScheduledPair(contactId, templateId, traceId);
};

export const RescheduleAlarmsTask = async () => {
  const startTime = Date.now();
  const traceId = generateTraceId('bootReschedule');
  debugTrace('RescheduleAlarmsTaskStart', { traceId, status: 'starting' });
  try {
    debugTrace('RearmAllScheduledAlarmsBefore', { traceId });
    const rearmed = await rearmAllScheduledAlarmsAfterBoot();
    debugTrace('RearmAllScheduledAlarmsAfter', { traceId, rearmedCount: rearmed });
    recordEngineRun('bootReschedule', { traceId, itemsProcessed: rearmed ?? 0 });
    debugTraceDuration('RescheduleAlarmsTaskEnd', startTime, {
      traceId, outcome: 'completed', rearmedCount: rearmed,
    });
  } catch (error) {
    debugTraceError('RescheduleAlarmsTaskCatch', error, { traceId, function: 'RescheduleAlarmsTask' });
    handleError(error, 'RescheduleAlarmsTask');
    debugTraceDuration('RescheduleAlarmsTaskEnd', startTime, { traceId, outcome: 'error' });
  }
};

/**
 * SafetyNetTask — Level 1 / Active Queue (Micro Safety-Net).
 *
 * Triggered by ExpirySafetyNetWorker (native WorkManager, ~15 min cadence).
 * Follows a strict scan-then-act pipeline: scanDatabase() is the ONE read
 * step that observes current state (what's overdue, what's queued) — the
 * same read layer the Test panel's Scan button and any future reporting
 * use. This function never re-derives "what's due" with its own query;
 * it acts only on exactly what scanDatabase() reported, so there is a
 * single source of truth for "what's due right now" shared by every
 * consumer, not a parallel computation that could drift from it.
 *
 * For each overdue row from the scan, fires it through the exact same
 * fireScheduledPair() path the exact-alarm receiver uses. No independent
 * rescan of contacts/templates, no separate grace-period rule — this was
 * the source of the silent-drop bug (overdue-by->1hr contacts were
 * permanently skipped and never queued). That rescan-based logic has been
 * removed from this path entirely; it no longer calls runExpiryCheck().
 *
 * Still finishes with a processQueue() pass — orthogonal to alarm firing —
 * to retry any message_queue row stuck in PENDING (e.g. reverted there
 * after an SMS rate-limit) since the app may have been closed the whole
 * time otherwise nothing would ever call processQueue() again for it.
 */
export const SafetyNetTask = async () => {
  const startTime = Date.now();
  const traceId = generateTraceId('safetyNet');
  debugTrace('SafetyNetTaskStart', { traceId, status: 'starting' });

  // FIX 7 — Distributed lock acquire karo
  // Agar doosra instance pehle se chal raha hai, foran return karo
  const lockAcquired = acquireSafetyNetLock(traceId);
  if (!lockAcquired) {
    debugTrace('SafetyNetTaskSkipped', { traceId, reason: 'lock_held_by_another_instance' });
    return;
  }

  try {
    // Step 1 — Scan: pure read, the single source of truth for "what's
    // due right now." Nothing has happened yet at this point.
    const scan = scanDatabase();
    debugTrace('SafetyNetTaskScan', {
      traceId,
      scheduledCount: scan.summary.scheduledCount,
      overdueCount: scan.summary.overdueCount,
      pendingQueueCount: scan.summary.pendingQueueCount,
    });

    // Step 2 — Act: fire exactly the rows the scan identified as overdue.
    let processed = 0;
    for (const row of scan.overdue) {
      const outcome = await fireScheduledPair(row.contact_id, row.template_id, traceId);
      if (outcome === 'fired') processed += 1;
    }

    // Step 3 — Send/retry: flush anything still sitting PENDING in the
    // queue (e.g. rate-limited earlier).
    await processQueue(undefined, traceId);

    recordEngineRun('safetyNet', { traceId, itemsProcessed: processed });
    debugTraceDuration('SafetyNetTaskEnd', startTime, {
      traceId, outcome: 'completed', dueCount: scan.overdue.length, processed,
    });
  } catch (error) {
    debugTraceError('SafetyNetTaskCatch', error, { traceId, function: 'SafetyNetTask' });
    handleError(error, 'SafetyNetTask');
    debugTraceDuration('SafetyNetTaskEnd', startTime, { traceId, outcome: 'error' });
  } finally {
    // FIX 7 — Lock hamesha release karo — chahe success ho ya error
    releaseSafetyNetLock(traceId);
  }
};

/**
 * ReconcilerTask — Level 2 / Reconciler (Macro Safety-Net).
 *
 * Triggered once a day by a separate low-frequency WorkManager job (see
 * ReconcilerWorker.kt). Does NOT fire anything — its only job is making
 * sure every (contact, active template) pair has a corresponding
 * scheduled_alarms row, so Level 1 always has something to find. Reuses
 * scheduleAlarmsForContact(), the same function contact-add/template-edit
 * already call; upsertScheduledAlarm() underneath is idempotent and will
 * never resurrect an already-fired/firing pair, so running this over every
 * contact daily is safe to repeat.
 *
 * This is the catch-up for the (rare) case where the synchronous
 * scheduling call at contact-add/template-edit time didn't complete or
 * persist (app killed mid-write, native module error, permission not yet
 * granted at that moment, etc.) — not a periodic scheduler in its own
 * right.
 */
export const ReconcilerTask = async () => {
  const startTime = Date.now();
  const traceId = generateTraceId('reconciler');
  debugTrace('ReconcilerTaskStart', { traceId, status: 'starting' });
  try {
    // Scan first (pure read) — same observation step SafetyNetTask starts
    // with, logged here purely for visibility into state going into this
    // run. Reconciler's own job (contact/template pair coverage) is a
    // different concern than scheduled_alarms/queue state, so the scan
    // result isn't used to decide what to do here — it's a snapshot for
    // the trace log, not a gate.
    const scan = scanDatabase();
    debugTrace('ReconcilerTaskScan', {
      traceId,
      scheduledCount: scan.summary.scheduledCount,
      overdueCount: scan.summary.overdueCount,
      pendingQueueCount: scan.summary.pendingQueueCount,
    });

    const contacts = getAllContacts();
    const templates = getActiveTemplates();
    debugTrace('ReconcilerTaskLoaded', { traceId, contactCount: contacts.length, templateCount: templates.length });

    let touched = 0;
    for (const contact of contacts) {
      await scheduleAlarmsForContact(contact, templates);
      touched += 1;
    }

    recordEngineRun('reconciler', { traceId, itemsProcessed: touched });
    debugTraceDuration('ReconcilerTaskEnd', startTime, {
      traceId, outcome: 'completed', contactsTouched: touched,
    });
  } catch (error) {
    debugTraceError('ReconcilerTaskCatch', error, { traceId, function: 'ReconcilerTask' });
    handleError(error, 'ReconcilerTask');
    debugTraceDuration('ReconcilerTaskEnd', startTime, { traceId, outcome: 'error' });
  }
};