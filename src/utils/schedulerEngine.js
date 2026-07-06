import { getExpiringContacts } from '../database/contactDB';
import { getActiveTemplates } from '../database/templateDB';
import { addToQueue } from '../database/messageQueueDB';
import { getDefaultPlatform } from '../database/settingsDB';
import { getDaysUntilExpiry, findMatchingTemplates } from './templateMatcher';
import { handleError } from './errorHandler';
import { processQueue } from './queueProcessor';
import { isTemplateAlarmDue } from './alarmScheduler';
import { debugTrace, debugTraceError, debugTraceDuration, generateTraceId } from './debugTrace';

// No lower bound — overdue contacts from any point in the past are still
// eligible for after-expiry (negative days_before) templates. Upper bound
// stays generous to cover long before-expiry windows too.
const FAR_PAST_YEARS   = 20;
const FAR_FUTURE_YEARS = 2;

export const runExpiryCheck = async (parentTraceId = null) => {
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

    expiringContacts.forEach((contact) => {
      const daysLeft = getDaysUntilExpiry(contact.expiry_datetime);
      // Date match (days_before) alone is not enough — the target
      // date+time (from send_time, or the expiry's own time-of-day if
      // send_time isn't set) must have actually arrived. Previously this
      // check was skipped entirely whenever send_time was blank, so a
      // date match alone would fire regardless of time.
      const matched  = findMatchingTemplates(templates, daysLeft).filter((template) =>
        isTemplateAlarmDue(contact, template),
      );

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
        skippedNoTemplate += 1;
        debugTrace('ExpiryCheckContactSkipped', { traceId, contactId: contact.id, exitReason: 'no_matching_template' });
        return;
      }

      matched.forEach((template) => {
        const added = addToQueue(contact.id, template.id, defaultPlatform);
        debugTrace('ExpiryCheckContactQueued', {
          traceId,
          contactId: contact.id,
          templateId: template.id,
          templateTitle: template.title,
          daysBefore: template.days_before,
          sendTime: template.send_time ?? 'expiry',
          added,
        });
        if (added) queued += 1;
      });
    });

    debugTrace('RunExpiryCheckSummary', { traceId, queued, skippedNoTemplate, checked: expiringContacts.length });

    if (queued > 0) {
      debugTrace('RunExpiryCheckAutoProcessQueueBefore', { traceId });
      processQueue(undefined, traceId).catch((err) => {
        debugTraceError('RunExpiryCheckAutoProcessQueueCatch', err, { function: 'runExpiryCheck.autoProcess', traceId });
        handleError(err, 'runExpiryCheck.autoProcess');
      });
    }

    debugTraceDuration('RunExpiryCheckEnd', startTime, { traceId, outcome: 'completed', queued, skippedNoTemplate });
    return { checked: expiringContacts.length, queued, skippedNoTemplate };
  } catch (error) {
    debugTraceError('RunExpiryCheckCatch', error, { function: 'runExpiryCheck', traceId });
    handleError(error, 'runExpiryCheck');
    debugTraceDuration('RunExpiryCheckEnd', startTime, { traceId, outcome: 'error' });
    return { checked: 0, queued: 0, skippedNoTemplate: 0 };
  }
};