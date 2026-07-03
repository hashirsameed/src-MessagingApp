import { getExpiringContacts } from '../database/contactDB';
import { getActiveTemplates } from '../database/templateDB';
import { addToQueue } from '../database/messageQueueDB';
import { getDefaultPlatform } from '../database/settingsDB';
import { getDaysUntilExpiry, findMatchingTemplates } from './templateMatcher';
import { handleError } from './errorHandler';
import { processQueue } from './queueProcessor';
import { isTemplateAlarmDue } from './alarmScheduler';

// No lower bound — overdue contacts from any point in the past are still
// eligible for after-expiry (negative days_before) templates. Upper bound
// stays generous to cover long before-expiry windows too.
const FAR_PAST_YEARS   = 20;
const FAR_FUTURE_YEARS = 2;

export const runExpiryCheck = async () => {
  try {
    const start = new Date();
    start.setFullYear(start.getFullYear() - FAR_PAST_YEARS);
    const end = new Date();
    end.setFullYear(end.getFullYear() + FAR_FUTURE_YEARS);

    const expiringContacts = getExpiringContacts(start, end);
    const templates        = getActiveTemplates();
    const defaultPlatform  = getDefaultPlatform() || 'sms';

    console.log(`[Scheduler] Run started — ${expiringContacts.length} contacts in window, ${templates.length} active templates`);

    let queued            = 0;
    let skippedNoTemplate = 0;

    expiringContacts.forEach((contact) => {
      const daysLeft = getDaysUntilExpiry(contact.expiry_datetime);
      const matched  = findMatchingTemplates(templates, daysLeft).filter((template) => {
        if (!template.send_time) return true;
        return isTemplateAlarmDue(contact, template);
      });

      console.log(`[Scheduler] ${contact.name} (${contact.phone_number}) — daysLeft=${daysLeft} — matched=${matched.length} template(s): [${matched.map(t => t.title).join(', ')}]`);

      if (matched.length === 0) {
        skippedNoTemplate += 1;
        return;
      }

      matched.forEach((template) => {
        const added = addToQueue(contact.id, template.id, defaultPlatform);
        console.log(`[Scheduler]   -> queued template "${template.title}" (days_before=${template.days_before}, send_time=${template.send_time ?? 'expiry'}) : ${added ? 'OK' : 'FAILED'}`);
        if (added) queued += 1;
      });
    });

    console.log(`[Scheduler] Run finished — queued=${queued}, skipped=${skippedNoTemplate}`);

    if (queued > 0) {
      processQueue().catch((err) =>
        handleError(err, 'runExpiryCheck.autoProcess'),
      );
    }

    return { checked: expiringContacts.length, queued, skippedNoTemplate };
  } catch (error) {
    handleError(error, 'runExpiryCheck');
    return { checked: 0, queued: 0, skippedNoTemplate: 0 };
  }
};
