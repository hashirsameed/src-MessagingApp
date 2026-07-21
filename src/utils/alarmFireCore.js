import { getContactById } from '../database/contactDB';
import { getTemplateById } from '../database/templateDB';
import { getDefaultPlatform } from '../database/settingsDB';
import { addToQueueDetailed } from '../database/messageQueueDB';
import { processQueue } from './queueProcessor';
import {
  claimScheduledAlarmForFiring,
  releaseScheduledAlarmClaim,
  markScheduledAlarmFired,
  markScheduledAlarmCancelled,
} from '../database/scheduledAlarmDB';
import { recordEngineRun } from '../database/engineStatusDB';
import { computeTargetAlarmTimestamp } from './alarmScheduler';
import { handleError } from './errorHandler';
import { debugTrace, debugTraceError, debugTraceDuration } from './debugTrace';

const TRIGGER_DRIFT_TOLERANCE_MS = 60 * 1000;

/**
 * fireScheduledPair — the single, shared "this (contactId, templateId) pair
 * is due right now" path. Every trigger source funnels through here:
 *   - AlarmReceiver → AlarmTaskService → AlarmFiredTask (exact-alarm fire)
 *   - ExpirySafetyNetWorker → SafetyNetTask (15-min catch-up for anything
 *     the exact alarm missed while still 'scheduled')
 *   - BootReceiver → RescheduleAlarmsTask → rearmAllScheduledAlarmsAfterBoot
 *     (a pair whose trigger time already passed during a reboot/downtime
 *     window, instead of being silently cancelled)
 *
 * Having one function means the claim CAS, drift validation, dedupe rules,
 * and processQueue() retry are identical no matter which path found the
 * pair — the exact bug class ("dual paths, different rules") this was
 * built to close.
 *
 * Returns one of: 'fired' | 'already_handled' | 'skipped' | 'error'
 */
export const fireScheduledPair = async (contactId, templateId, traceId) => {
  const startTime = Date.now();

  debugTrace('FireScheduledPairStart', { traceId, contactId, templateId });

  if (!contactId || !templateId) {
    debugTraceDuration('FireScheduledPairExit', startTime, {
      traceId, contactId, templateId, exitReason: 'missing_contact_or_template_id',
    });
    return 'skipped';
  }

  try {
    // Atomic CAS guard — only the caller that wins 'scheduled' -> 'firing'
    // proceeds; every other caller (or trigger source) racing on the same
    // pair bails here with zero side effects.
    const { claimed, row: alarmRow } = claimScheduledAlarmForFiring(contactId, templateId);
    debugTrace('FireScheduledPairClaim', {
      traceId, contactId, templateId, claimed, status: alarmRow?.status ?? 'not_found',
    });

    if (!claimed) {
      debugTraceDuration('FireScheduledPairExit', startTime, {
        traceId, contactId, templateId, exitReason: 'already_claimed_or_no_active_row',
        status: alarmRow?.status ?? 'not_found',
      });
      return 'skipped';
    }

    const template = getTemplateById(templateId);
    if (!template) {
      markScheduledAlarmCancelled(contactId, templateId);
      debugTraceDuration('FireScheduledPairExit', startTime, {
        traceId, contactId, templateId, exitReason: 'template_not_found',
      });
      return 'skipped';
    }
    if (template.is_active !== 1) {
      markScheduledAlarmCancelled(contactId, templateId);
      debugTraceDuration('FireScheduledPairExit', startTime, {
        traceId, contactId, templateId, exitReason: 'template_inactive',
      });
      return 'skipped';
    }

    const contact = getContactById(contactId);
    if (!contact) {
      markScheduledAlarmCancelled(contactId, templateId);
      debugTraceDuration('FireScheduledPairExit', startTime, {
        traceId, contactId, templateId, exitReason: 'contact_deleted',
      });
      return 'skipped';
    }

    // Drift check: has the contact/template data changed since this pair
    // was scheduled (expiry date edited, send_time changed) — NOT a check
    // on how late the OS delivered the trigger. A late-but-otherwise-valid
    // fire (Doze delay, safety-net catch-up, post-reboot recovery) always
    // passes this; only genuinely stale schedules get cancelled.
    const recomputed = computeTargetAlarmTimestamp(contact, template);
    const originalMs = new Date(alarmRow.trigger_at).getTime();
    const driftMs = recomputed === null ? null : Math.abs(recomputed - originalMs);

    debugTrace('FireScheduledPairDrift', {
      traceId, contactId, templateId, recomputedMs: recomputed ?? '', originalMs,
      driftMs: driftMs ?? 'null_recomputed', toleranceMs: TRIGGER_DRIFT_TOLERANCE_MS,
    });

    if (recomputed === null || driftMs > TRIGGER_DRIFT_TOLERANCE_MS) {
      markScheduledAlarmCancelled(contactId, templateId);
      debugTraceDuration('FireScheduledPairExit', startTime, {
        traceId, contactId, templateId, exitReason: 'trigger_drift_detected',
      });
      return 'skipped';
    }

    const defaultPlatform = template.platform_id || getDefaultPlatform() || 'sms';
    const { added, reason } = addToQueueDetailed(contactId, templateId, defaultPlatform, traceId);
    debugTrace('FireScheduledPairQueueInsertion', {
      traceId, contactId, templateId, added, reason,
    });

    if (added) {
      markScheduledAlarmFired(contactId, templateId);
      await processQueue(null, traceId);
      recordEngineRun('alarmFired', { traceId, contactId, templateId, itemsProcessed: 1 });
      debugTraceDuration('FireScheduledPairEnd', startTime, {
        traceId, contactId, templateId, outcome: 'fired',
      });
      return 'fired';
    }

    if (reason === 'ALREADY_PENDING' || reason === 'ALREADY_SENT_RECENTLY') {
      markScheduledAlarmFired(contactId, templateId);
      debugTraceDuration('FireScheduledPairEnd', startTime, {
        traceId, contactId, templateId, outcome: 'already_handled', reason,
      });
      return 'already_handled';
    }

    // Transient failure (e.g. DB error inside addToQueueDetailed) — release
    // the claim back to 'scheduled' so a later run (safety-net, next boot)
    // can retry this pair instead of it being stuck in 'firing' forever.
    releaseScheduledAlarmClaim(contactId, templateId);
    debugTraceDuration('FireScheduledPairExit', startTime, {
      traceId, contactId, templateId, exitReason: 'queue_db_error', reason,
      note: 'claim_released_for_fallback_recovery',
    });
    return 'error';
  } catch (error) {
    releaseScheduledAlarmClaim(contactId, templateId);
    debugTraceError('FireScheduledPairCatch', error, { traceId, function: 'fireScheduledPair', contactId, templateId });
    handleError(error, 'fireScheduledPair');
    debugTraceDuration('FireScheduledPairEnd', startTime, {
      traceId, contactId, templateId, outcome: 'error',
    });
    return 'error';
  }
};
