import { getExpiringContacts } from '../database/contactDB';
import { getActiveTemplates } from '../database/templateDB';
import { addToQueue } from '../database/messageQueueDB';
import { getDefaultPlatform } from '../database/settingsDB';
import { getDaysUntilExpiry, findMatchingTemplates } from './templateMatcher';
import { handleError } from './errorHandler';
import { isTemplateAlarmDue, computeTargetAlarmTimestamp, wasAlarmTargetBeforeContactCreated } from './alarmScheduler';
import { debugTrace, debugTraceError, debugTraceDuration, generateTraceId } from './debugTrace';
import { FAR_PAST_YEARS, FAR_FUTURE_YEARS, MAX_TEMPLATE_GRACE_PERIOD_MS } from './schedulerConstants';

// ─────────────────────────────────────────────────────────────────────────────
// FIX 3 — runExpiryCheck re-entrancy guard
// Masla: AppState foreground check aur background SafetyNetTask ek waqt mein
//         runExpiryCheck() call kar sakte hain. DB ka UNIQUE index duplicates
//         rokta hai lekin double kaam aur confusing logs hote hain.
// Fix:   Module-level _checkInProgress flag. Doosri call foran return karti hai.
// ─────────────────────────────────────────────────────────────────────────────
let _checkInProgress = false;

export const runExpiryCheck = async (parentTraceId = null) => {
  // FIX 3 — Re-entrancy guard: agar pehle se chal raha hai to foran return karo
  if (_checkInProgress) {
    debugTrace('RunExpiryCheckSkipped', { reason: 'already_running', parentTraceId: parentTraceId ?? 'none' });
    return { checked: 0, queued: 0, skippedNoTemplate: 0, skippedTimeWindow: 0 };
  }
  _checkInProgress = true;

  const startTime = Date.now();
  const traceId = parentTraceId ?? generateTraceId('runExpiryCheck');
  debugTrace('RunExpiryCheckStart', { traceId, parentTraceId: parentTraceId ?? 'none' });

  try {
    const start = new Date();
    start.setFullYear(start.getFullYear() - FAR_PAST_YEARS);
    const end = new Date();
    end.setFullYear(end.getFullYear() + FAR_FUTURE_YEARS);

    debugTrace('LoadExpiryCheckDataBefore', { traceId });
    const expiringContacts = getExpiringContacts(start, end);
    const templates        = getActiveTemplates();
    const defaultPlatform  = getDefaultPlatform() || 'sms';
    debugTrace('LoadExpiryCheckDataAfter', {
      traceId,
      contactsInWindow: expiringContacts.length,
      activeTemplateCount: templates.length,
      defaultPlatform,
    });

    let queued            = 0;
    let skippedNoTemplate = 0;
    let skippedTimeWindow = 0;
    const nowMs = Date.now();

    expiringContacts.forEach((contact) => {
      const daysLeft = getDaysUntilExpiry(contact.expiry_datetime);
      
      // ── Single-pass filter: compute alarmMs ONCE per template ─────────
      // Previously isTemplateAlarmDue() called computeTargetAlarmTimestamp
      // internally, then the grace-window check called it AGAIN, doubling
      // Pakistan-time conversions per (contact, template) pair. Now alarmMs
      // is cached and reused for both checks.
      const windowSkipped = { count: 0 };
      const matched  = findMatchingTemplates(templates, daysLeft).filter((template) => {
        // Compute once, use twice — avoids redundant Pakistan-time conversion
        const alarmMs = computeTargetAlarmTimestamp(contact, template);
        if (alarmMs === null) return false;

        // 1. Not before contact creation AND time must have arrived
        if (wasAlarmTargetBeforeContactCreated(contact, alarmMs)) return false;
        if (alarmMs > nowMs) return false;

        // 2. STRICT TIME WINDOW CHECK:
        // Only pick this template if its scheduled time is within the grace
        // period. Prevents a template scheduled for 5 PM from being picked
        // up at 8 PM. Count skipped-for-window templates during the main
        // pass instead of re-filtering later.
        const timeSinceAlarm = nowMs - alarmMs;
        const inWindow = timeSinceAlarm >= 0 && timeSinceAlarm <= MAX_TEMPLATE_GRACE_PERIOD_MS;

        debugTrace('TemplateTimeWindowCheck', {
          traceId,
          contactId: contact.id,
          templateId: template.id,
          templateTitle: template.title,
          sendTime: template.send_time ?? 'expiry',
          alarmMs,
          timeSinceAlarmMs: timeSinceAlarm,
          inWindow,
        });

        if (!inWindow) windowSkipped.count += 1;
        return inWindow;
      });

      debugTrace('ExpiryCheckContactEvaluated', {
        traceId,
        contactId: contact.id,
        contactName: contact.name,
        phoneNumber: contact.phone_number,
        daysLeft,
        matchedTemplateCount: matched.length,
        matchedTemplateTitles: matched.map((t) => t.title).join('|'),
      });

      if (matched.length === 0) {
        if (windowSkipped.count > 0) {
          skippedTimeWindow += windowSkipped.count;
          debugTrace('ExpiryCheckContactSkippedTimeWindow', {
            traceId,
            contactId: contact.id,
            exitReason: 'outside_time_window',
            dueButSkippedCount: windowSkipped.count,
          });
        } else {
          skippedNoTemplate += 1;
          debugTrace('ExpiryCheckContactSkipped', { traceId, contactId: contact.id, exitReason: 'no_matching_template' });
        }
        return;
      }

      matched.forEach((template) => {
        const platformId = template.platform_id || defaultPlatform;
        const added = addToQueue(contact.id, template.id, platformId);
        debugTrace('ExpiryCheckContactQueued', {
          traceId,
          contactId: contact.id,
          templateId: template.id,
          templateTitle: template.title,
          daysBefore: template.days_before,
          sendTime: template.send_time ?? 'expiry',
          platformId,
          added,
        });
        if (added) queued += 1;
      });
    });

    debugTrace('RunExpiryCheckSummary', { 
      traceId, 
      queued, 
      skippedNoTemplate, 
      skippedTimeWindow,
      checked: expiringContacts.length 
    });

    // Always attempt processQueue(), not just when this run queued something
    // new. A rate-limited item goes back to PENDING and just sits there
    // until *something* calls processQueue() again — if nothing new gets
    // matched on a later cycle (queued stays 0), that PENDING item was
    // stuck forever even after its rate-limit window rolled over.
    // processQueue() itself is cheap to call with nothing to do — it exits
    // immediately if claimPendingQueue() finds no PENDING rows.
    // ─────────────────────────────────────────────────────────────────────────
    // FIX — Present-due messages process karo
    // Masla: runExpiryCheck ke baad foran processQueue() nahi hota tha, is
    //         liye messages jo "abhi" due hain (e.g. contact 6:59 par add hua
    //         aur expiry bhi 6:59) queue mein PENDING reh jaate the aur koi
    //         native alarm bhi schedule nahi hota (kyunke timestamp already
    //         present/past hai) — result: message 15 min tak nahi jaata.
    // Fix:   Sirf tab processQueue() call karo jab kuch QUEUED ho. Is waqt
    //         claimPendingQueue() pehle se `datetime(scheduled_for) <=
    //         datetime('now')` guard lagata hai, to sirf genuinely-due items
    //         claim hote hain — future items untouched. `countPriorSends()`
    //         + `_isProcessing` guard duplicate send bhi rokta hai.
    // ─────────────────────────────────────────────────────────────────────────
    if (queued > 0) {
      debugTrace('RunExpiryCheckTriggerProcessQueue', { traceId, queued });
      const { processQueue } = require('./queueProcessor');
      processQueue(undefined, traceId).catch((err) => {
        debugTraceError('RunExpiryCheckProcessQueueCatch', err, { traceId });
      });
    }

    debugTraceDuration('RunExpiryCheckEnd', startTime, {
      traceId,
      outcome: 'completed',
      queued,
      skippedNoTemplate,
      skippedTimeWindow,
    });

    return { checked: expiringContacts.length, queued, skippedNoTemplate, skippedTimeWindow };
  } catch (error) {
    debugTraceError('RunExpiryCheckCatch', error, { function: 'runExpiryCheck', traceId });
    handleError(error, 'runExpiryCheck');
    debugTraceDuration('RunExpiryCheckEnd', startTime, { traceId, outcome: 'error' });
    return { checked: 0, queued: 0, skippedNoTemplate: 0, skippedTimeWindow: 0 };
  } finally {
    // FIX 3 — Lock hamesha release karo, chahe error aaye ya na aaye
    _checkInProgress = false;
  }
};
