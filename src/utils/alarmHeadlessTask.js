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
import { computeTargetAlarmTimestamp, rearmAllScheduledAlarmsAfterBoot } from './alarmScheduler';
import { runExpiryCheck } from './schedulerEngine';
import { handleError } from './errorHandler';
import { debugTrace, debugTraceError, debugTraceDuration, generateTraceId } from './debugTrace';

const TRIGGER_DRIFT_TOLERANCE_MS = 60 * 1000;

export const AlarmFiredTask = async (data) => {
  const startTime = Date.now();
  const { contactId, templateId, requestCode } = data ?? {};
  const traceId = generateTraceId('alarmFired');

  debugTrace('AlarmFiredTaskStart', {
    traceId,
    contactId,
    templateId,
    requestCode,
    status: 'starting',
  });

  try {
    if (!contactId || !templateId) {
      debugTraceDuration('AlarmFiredTaskExit', startTime, {
        traceId,
        contactId,
        templateId,
        requestCode,
        exitReason: 'missing_contact_or_template_id',
      });
      return;
    }

    // Atomic CAS guard — this is what makes it safe for AlarmReceiver,
    // ExpirySafetyNetWorker, and a post-boot reschedule to all potentially
    // reach this same (contactId, templateId) pair. Only the caller that
    // wins the 'scheduled' -> 'firing' transition proceeds; everyone else
    // bails here with zero side effects. This is the fix for the
    // duplicate-send-on-reopen and safety-net-resends-already-sent bugs.
    debugTrace('ClaimAlarmBefore', { traceId, contactId, templateId, requestCode });
    const { claimed, row: alarmRow } = claimScheduledAlarmForFiring(contactId, templateId);
    debugTrace('ClaimAlarmAfter', {
      traceId,
      contactId,
      templateId,
      requestCode,
      claimed,
      status: alarmRow?.status ?? 'not_found',
      triggerAt: alarmRow?.trigger_at ?? '',
    });

    if (!claimed) {
      debugTraceDuration('AlarmFiredTaskExit', startTime, {
        traceId,
        contactId,
        templateId,
        requestCode,
        exitReason: 'already_claimed_or_no_active_row',
        status: alarmRow?.status ?? 'not_found',
      });
      return;
    }

    debugTrace('LoadTemplateBefore', { traceId, contactId, templateId, requestCode });
    const template = getTemplateById(templateId);
    debugTrace('LoadTemplateAfter', {
      traceId,
      contactId,
      templateId,
      requestCode,
      found: !!template,
      isActive: template?.is_active ?? '',
    });

    if (!template) {
      debugTraceDuration('AlarmFiredTaskExit', startTime, {
        traceId, contactId, templateId, requestCode, exitReason: 'template_not_found',
      });
      markScheduledAlarmCancelled(contactId, templateId);
      return;
    }
    if (template.is_active !== 1) {
      debugTraceDuration('AlarmFiredTaskExit', startTime, {
        traceId, contactId, templateId, requestCode, exitReason: 'template_inactive', status: 'inactive',
      });
      markScheduledAlarmCancelled(contactId, templateId);
      return;
    }

    debugTrace('LoadContactBefore', { traceId, contactId, templateId, requestCode });
    const contact = getContactById(contactId);
    debugTrace('LoadContactAfter', {
      traceId, contactId, templateId, requestCode, found: !!contact,
    });

    if (!contact) {
      debugTraceDuration('AlarmFiredTaskExit', startTime, {
        traceId, contactId, templateId, requestCode, exitReason: 'contact_deleted',
      });
      markScheduledAlarmCancelled(contactId, templateId);
      return;
    }

    debugTrace('DriftValidationBefore', {
      traceId, contactId, templateId, requestCode, originalTriggerAt: alarmRow.trigger_at,
    });
    const recomputed = computeTargetAlarmTimestamp(contact, template);
    const originalMs = new Date(alarmRow.trigger_at).getTime();
    const driftMs = recomputed === null ? null : Math.abs(recomputed - originalMs);

    debugTrace('DriftValidationAfter', {
      traceId,
      contactId,
      templateId,
      requestCode,
      recomputedMs: recomputed ?? '',
      originalMs,
      driftMs: driftMs ?? 'null_recomputed',
      toleranceMs: TRIGGER_DRIFT_TOLERANCE_MS,
      passed: recomputed !== null && driftMs <= TRIGGER_DRIFT_TOLERANCE_MS,
    });

    if (recomputed === null || Math.abs(recomputed - originalMs) > TRIGGER_DRIFT_TOLERANCE_MS) {
      debugTraceDuration('AlarmFiredTaskExit', startTime, {
        traceId, contactId, templateId, requestCode, exitReason: 'trigger_drift_detected',
      });
      markScheduledAlarmCancelled(contactId, templateId);
      return;
    }

    const defaultPlatform = getDefaultPlatform() || 'sms';
    debugTrace('QueueInsertionBefore', {
      traceId, contactId, templateId, requestCode, platformId: defaultPlatform,
    });
    const { added, reason } = addToQueueDetailed(contactId, templateId, defaultPlatform, traceId);
    debugTrace('QueueInsertionAfter', {
      traceId, contactId, templateId, requestCode, added, reason,
    });

    if (added) {
      debugTrace('AlarmStatusUpdateBefore', {
        traceId, contactId, templateId, requestCode, targetStatus: 'fired', reason: 'queue_added',
      });
      markScheduledAlarmFired(contactId, templateId);
      debugTrace('ProcessQueueBefore', { traceId, contactId, templateId, requestCode });
      await processQueue(null, traceId);
      debugTrace('ProcessQueueAfter', { traceId, contactId, templateId, requestCode });
    } else if (reason === 'ALREADY_PENDING' || reason === 'ALREADY_SENT_RECENTLY') {
      debugTrace('AlarmFiredTaskDedupeSkip', {
        traceId, contactId, templateId, requestCode, reason, exitReason: 'already_queued_or_sent',
      });
      debugTrace('AlarmStatusUpdateBefore', {
        traceId, contactId, templateId, requestCode, targetStatus: 'fired', reason,
      });
      markScheduledAlarmFired(contactId, templateId);
    } else {
      // Transient failure (e.g. DB error inside addToQueueDetailed) — release
      // the claim back to 'scheduled' so the safety-net worker can retry
      // this pair later instead of it being stuck in 'firing' forever.
      releaseScheduledAlarmClaim(contactId, templateId);
      debugTrace('AlarmFiredTaskExit', {
        traceId,
        contactId,
        templateId,
        requestCode,
        exitReason: 'queue_db_error',
        reason,
        status: 'scheduled',
        note: 'claim_released_for_fallback_recovery',
      });
    }

    recordEngineRun('alarmFired', { traceId, contactId, templateId, itemsProcessed: added ? 1 : 0 });
    debugTraceDuration('AlarmFiredTaskEnd', startTime, {
      traceId, contactId, templateId, requestCode, outcome: 'completed',
    });
  } catch (error) {
    releaseScheduledAlarmClaim(contactId, templateId);
    debugTraceError('AlarmFiredTaskCatch', error, {
      traceId, function: 'AlarmFiredTask', contactId, templateId, requestCode,
    });
    handleError(error, 'AlarmFiredTask');
    debugTraceDuration('AlarmFiredTaskEnd', startTime, {
      traceId, contactId, templateId, requestCode, outcome: 'error',
    });
  }
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
 * SafetyNetTask
 *
 * Triggered by ExpirySafetyNetWorker (native WorkManager, ~15 min cadence).
 * Reuses the exact same runExpiryCheck() the app already runs on foreground
 * startup/resume/interval — this is intentional: it means "due but never
 * queued" and "queued but stuck" contacts get caught the same way whether
 * the app is open or fully killed, with one code path to maintain.
 */
export const SafetyNetTask = async () => {
  const startTime = Date.now();
  const traceId = generateTraceId('safetyNet');
  debugTrace('SafetyNetTaskStart', { traceId, status: 'starting' });
  try {
    const summary = await runExpiryCheck(traceId);
    recordEngineRun('safetyNet', { traceId, itemsProcessed: summary?.queued ?? 0 });
    debugTraceDuration('SafetyNetTaskEnd', startTime, {
      traceId, outcome: 'completed', summary: JSON.stringify(summary ?? {}),
    });
  } catch (error) {
    debugTraceError('SafetyNetTaskCatch', error, { traceId, function: 'SafetyNetTask' });
    handleError(error, 'SafetyNetTask');
    debugTraceDuration('SafetyNetTaskEnd', startTime, { traceId, outcome: 'error' });
  }
};