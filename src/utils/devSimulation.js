import { getExpiringContacts } from '../database/contactDB';
import { getActiveTemplates } from '../database/templateDB';
import { findMatchingTemplates, personalizeMessage } from './templateMatcher';
import { isTemplateAlarmDue, computeTargetAlarmTimestamp } from './alarmScheduler';
import { toPakistanParts, pakistanPartsToUtcMs } from './pakistanTime';

// Same bounds as schedulerEngine.runExpiryCheck.
const FAR_PAST_YEARS = 20;
const FAR_FUTURE_YEARS = 2;
const MAX_TEMPLATE_GRACE_PERIOD_MS = 60 * 60 * 1000; // 1 hour

// templateMatcher's getDaysUntilExpiry always anchors to the real
// `new Date()` — fine for production, useless for a time-travel simulator.
// This is the same Pakistan-calendar math, anchored to whatever "now" the
// Dev Testing Lab is simulating instead.
const getDaysUntilExpiryAt = (expiryDatetime, atMs) => {
  const nowParts = toPakistanParts(new Date(atMs));
  const todayPktMs = pakistanPartsToUtcMs(nowParts.year, nowParts.month, nowParts.day);

  const expiry = new Date(expiryDatetime);
  const expiryParts = toPakistanParts(expiry);
  const expiryPktMs = pakistanPartsToUtcMs(expiryParts.year, expiryParts.month, expiryParts.day);

  return Math.round((expiryPktMs - todayPktMs) / (1000 * 60 * 60 * 24));
};

/**
 * Read-only dry-run mirror of schedulerEngine.runExpiryCheck — identical
 * contact × template matching and grace-window logic, but anchored to a
 * caller-supplied "now" (for time-travel testing) instead of the real
 * clock. Guaranteed side-effect free: never calls addToQueue, processQueue,
 * writes to scheduled_alarms, or touches the native AlarmModule. Safe to
 * call repeatedly from the Dev Testing Lab.
 */
export const simulateExpiryCheckAt = (fakeNowMs) => {
  const start = new Date(fakeNowMs);
  start.setFullYear(start.getFullYear() - FAR_PAST_YEARS);
  const end = new Date(fakeNowMs);
  end.setFullYear(end.getFullYear() + FAR_FUTURE_YEARS);

  const expiringContacts = getExpiringContacts(start, end);
  const templates = getActiveTemplates();

  const fired = [];

  expiringContacts.forEach((contact) => {
    const daysLeft = getDaysUntilExpiryAt(contact.expiry_datetime, fakeNowMs);

    const matched = findMatchingTemplates(templates, daysLeft).filter((template) => {
      if (!isTemplateAlarmDue(contact, template, fakeNowMs)) return false;

      const alarmMs = computeTargetAlarmTimestamp(contact, template);
      if (alarmMs === null) return false;

      const timeSinceAlarm = fakeNowMs - alarmMs;
      return timeSinceAlarm >= 0 && timeSinceAlarm <= MAX_TEMPLATE_GRACE_PERIOD_MS;
    });

    matched.forEach((template) => {
      const platformId = template.platform_id ?? 'sms';
      // WhatsApp templates use Meta's {{1}} placeholder syntax (filled with
      // contact.name at send time), not the {name}/{days}/... tokens
      // personalizeMessage() handles for SMS/Email/Gmail.
      const rendered = platformId === 'whatsapp'
        ? (template.body ?? '').replace(/\{\{\s*1\s*\}\}/g, contact.name ?? '')
        : personalizeMessage(template.body, contact, daysLeft);

      fired.push({
        contactId: contact.id,
        contactName: contact.name,
        phone: contact.phone_number,
        templateId: template.id,
        templateTitle: template.title,
        platformId,
        metaTemplateName: template.meta_template_name ?? null,
        daysLeft,
        rendered,
      });
    });
  });

  return fired;
};
