import { getContactById } from '../database/contactDB';
import { getTemplateById } from '../database/templateDB';
import { getDefaultPlatform } from '../database/settingsDB';
import { getQueueRowById } from '../database/messageQueueDB';
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
 * fireScheduledPair — Layer B "Read-Only Guard Rail" Workflow
 *
 * 1. Claims the scheduled_alarms row (CAS guard).
 * 2. Fetches the EXISTING message_queue row via exported getter (no raw getDB).
 * 3. READ-ONLY GUARD RAIL: aborts if the queue row was SUPERSEDED/CANCELLED/SENT.
 * 4. Does NOT claim the message_queue row here — leaves it PENDING.
 * 5. Triggers processQueue(null, traceId); processQueue itself performs the
 *    PENDING -> CLAIMED atomic claim (this is what processQueue was already
 *    designed to do — see claimPendingQueue in messageQueueDB.js).
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
    const { claimed, row: alarmRow } = claimScheduledAlarmForFiring(contactId, templateId);
    debugTrace('FireScheduledPairClaim', {
      traceId, contactId, templateId, claimed, status: alarmRow?.status ?? 'not_found',
    });

    if (!claimed || !alarmRow?.queue_id) {
      debugTraceDuration('FireScheduledPairExit', startTime, {
        traceId, contactId, templateId, exitReason: 'already_claimed_or_no_active_row',
        status: alarmRow?.status ?? 'not_found',
      });
      return 'skipped';
    }

    const mqRow = getQueueRowById(alarmRow.queue_id);

    if (!mqRow || mqRow.status === 'SUPERSEDED' || mqRow.status === 'CANCELLED' || mqRow.status === 'SENT') {
      debugTrace('FireScheduledPairAbortSuperseded', {
        traceId, contactId, templateId, queueId: alarmRow.queue_id, mqStatus: mqRow?.status ?? 'DELETED',
      });
      markScheduledAlarmCancelled(contactId, templateId);
      debugTraceDuration('FireScheduledPairExit', startTime, {
        traceId, contactId, templateId, exitReason: 'superseded_or_invalid_queue_row',
      });
      return 'already_handled';
    }

    const template = getTemplateById(templateId);
    if (!template || template.is_active !== 1) {
      markScheduledAlarmCancelled(contactId, templateId);
      debugTraceDuration('FireScheduledPairExit', startTime, {
        traceId, contactId, templateId, exitReason: 'template_not_found_or_inactive',
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

    const recomputed = computeTargetAlarmTimestamp(contact, template);
    const originalMs = new Date(alarmRow.trigger_at).getTime();
    const driftMs = recomputed === null ? null : Math.abs(recomputed - originalMs);

    if (recomputed === null || driftMs > TRIGGER_DRIFT_TOLERANCE_MS) {
      markScheduledAlarmCancelled(contactId, templateId);
      debugTraceDuration('FireScheduledPairExit', startTime, {
        traceId, contactId, templateId, exitReason: 'trigger_drift_detected',
      });
      return 'skipped';
    }

    await processQueue(null, traceId);

    markScheduledAlarmFired(contactId, templateId);
    recordEngineRun('alarmFired', { traceId, contactId, templateId, queueId: alarmRow.queue_id });

    debugTraceDuration('FireScheduledPairEnd', startTime, {
      traceId, contactId, templateId, outcome: 'fired', queueId: alarmRow.queue_id,
    });
    return 'fired';

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