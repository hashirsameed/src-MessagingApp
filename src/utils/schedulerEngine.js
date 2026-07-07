import { getExpiringContacts } from '../database/contactDB';
import { getActiveTemplates } from '../database/templateDB';
import { addToQueue } from '../database/messageQueueDB';
import { getDefaultPlatform } from '../database/settingsDB';
import { getDaysUntilExpiry, findMatchingTemplates } from './templateMatcher';
import { handleError } from './errorHandler';
import { processQueue } from './queueProcessor';
import { isTemplateAlarmDue, computeTargetAlarmTimestamp } from './alarmScheduler';
import { debugTrace, debugTraceError, debugTraceDuration, generateTraceId } from './debugTrace';

// No lower bound — overdue contacts from any point in the past are still
// eligible for after-expiry (negative days_before) templates. Upper bound
// stays generous to cover long before-expiry windows too.
const FAR_PAST_YEARS   = 20;
const FAR_FUTURE_YEARS = 2;

// Maximum grace period (in ms) after a template's exact send_time during which
// it is still eligible to be picked up by the scheduler. This prevents a 
// template scheduled for 5 PM from being picked up at 8 PM.
const MAX_TEMPLATE_GRACE_PERIOD_MS = 60 * 60 * 1000; // 1 hour

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
    let skippedTimeWindow = 0;
    const nowMs = Date.now();

    expiringContacts.forEach((contact) => {
      const daysLeft = getDaysUntilExpiry(contact.expiry_datetime);
      
      const matched  = findMatchingTemplates(templates, daysLeft).filter((template) => {
        // 1. The alarm time must have arrived (existing logic)
        if (!isTemplateAlarmDue(contact, template, nowMs)) return false;
        
        // 2. STRICT TIME WINDOW CHECK:
        // Only pick this template if its scheduled time is within the grace period.
        // This ensures that if multiple templates exist for the same days_before,
        // ONLY the one whose exact send_time has recently arrived is picked.
        const alarmMs = computeTargetAlarmTimestamp(contact, template);
        if (alarmMs === null) return false;
        
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
        // Check if it was skipped due to time window
        const allDueTemplates = findMatchingTemplates(templates, daysLeft).filter((t) => 
          isTemplateAlarmDue(contact, t, nowMs)
        );
        if (allDueTemplates.length > 0) {
          skippedTimeWindow += allDueTemplates.length;
          debugTrace('ExpiryCheckContactSkippedTimeWindow', { 
            traceId, 
            contactId: contact.id, 
            exitReason: 'outside_time_window',
            dueButSkippedCount: allDueTemplates.length,
          });
        } else {
          skippedNoTemplate += 1;
          debugTrace('ExpiryCheckContactSkipped', { traceId, contactId: contact.id, exitReason: 'no_matching_template' });
        }
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

    debugTrace('RunExpiryCheckSummary', { 
      traceId, 
      queued, 
      skippedNoTemplate, 
      skippedTimeWindow,
      checked: expiringContacts.length 
    });

    if (queued > 0) {
      debugTrace('RunExpiryCheckAutoProcessQueueBefore', { traceId });
      processQueue(undefined, traceId).catch((err) => {
        debugTraceError('RunExpiryCheckAutoProcessQueueCatch', err, { function: 'runExpiryCheck.autoProcess', traceId });
        handleError(err, 'runExpiryCheck.autoProcess');
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
  }
};