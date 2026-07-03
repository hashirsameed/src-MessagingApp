/**
 * Days remaining until expiry, based on the contact's UTC expiry_datetime.
 * Calendar-day diff is computed in UTC to stay consistent with how
 * expiry_datetime is stored (always UTC ISO).
 */
export const getDaysUntilExpiry = (expiryDatetime) => {
  const now = new Date();
  const todayUTC = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());

  const expiry = new Date(expiryDatetime);
  const expiryUTC = Date.UTC(expiry.getUTCFullYear(), expiry.getUTCMonth(), expiry.getUTCDate());

  const diff = expiryUTC - todayUTC;
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
    .replace(/\{expiry\}/gi, contact.expiry_datetime ?? '');
};