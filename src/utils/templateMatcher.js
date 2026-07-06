import { toPakistanParts, pakistanPartsToUtcMs, formatPakistanDateTime } from './pakistanTime';

/**
 * Days remaining until expiry, counted on the Pakistan calendar (not UTC,
 * not the device's local calendar) — so "3 days before expiry" always
 * means 3 Pakistan-calendar days, regardless of where the phone is set.
 */
export const getDaysUntilExpiry = (expiryDatetime) => {
  const now = new Date();
  const nowParts = toPakistanParts(now);
  const todayPktMs = pakistanPartsToUtcMs(nowParts.year, nowParts.month, nowParts.day);

  const expiry = new Date(expiryDatetime);
  const expiryParts = toPakistanParts(expiry);
  const expiryPktMs = pakistanPartsToUtcMs(expiryParts.year, expiryParts.month, expiryParts.day);

  const diff = expiryPktMs - todayPktMs;
  return Math.round(diff / (1000 * 60 * 60 * 24));
};

/**
 * Find ALL active templates matching daysLeft.
 * Returns array — multiple templates can match same day.
 */
export const findMatchingTemplates = (templates, daysLeft) => {
  return templates.filter(
    (t) => t.is_active === 1 && t.days_before === daysLeft
  );
};

/**
 * Keep old single-match for backward compat — returns first match only.
 */
export const findMatchingTemplate = (templates, daysLeft) => {
  return findMatchingTemplates(templates, daysLeft)[0] ?? null;
};

export const personalizeMessage = (body, contact, daysLeft) => {
  return body
    .replace(/\{name\}/gi, contact.name ?? '')
    .replace(/\{phone\}/gi, contact.phone_number ?? '')
    .replace(/\{days\}/gi, daysLeft.toString())
    .replace(/\{expiry\}/gi, formatPakistanDateTime(contact.expiry_datetime));
};