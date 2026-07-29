import { toPakistanParts, pakistanPartsToUtcMs, formatPakistanDate } from './pakistanTime';
import { classifyTiming } from './expiryTiming';

/**
 * Days remaining until expiry, counted on the Pakistan calendar (not UTC,
 * not the device's local calendar) — so "3 days before expiry" always
 * means 3 Pakistan-calendar days, regardless of where the phone is set.
 */
export const getDaysUntilExpiry = (expiryDatetime, nowMs = Date.now()) => {
  const now = new Date(nowMs);
  const nowParts = toPakistanParts(now);
  const todayPktMs = pakistanPartsToUtcMs(nowParts.year, nowParts.month, nowParts.day);

  const expiry = new Date(expiryDatetime);
  const expiryParts = toPakistanParts(expiry);
  const expiryPktMs = pakistanPartsToUtcMs(expiryParts.year, expiryParts.month, expiryParts.day);

  const diff = expiryPktMs - todayPktMs;
  const daysDiff = Math.round(diff / (1000 * 60 * 60 * 24));

  // ─────────────────────────────────────────────────────────────────────
  // CRITICAL FIX — present-time edge case (±60s buffer)
  // Masla: purana check `expiry < now` STRICT tha — agar contact ka
  //         expiry aur "abhi" (now) ka waqt EXACT same minute/second ho
  //         (e.g. contact 7:38:00 PM par add hua aur expiry bhi 7:38 PM
  //         hai), to `new Date(expiryDatetime)` aur `new Date()` ke beech
  //         chand milliseconds ka natural gap hamesha expiry < now true
  //         kar deta — result: contact turant "Expired" (-1) dikhta aur
  //         days_before=0 ("on expiry") wala template kabhi match hi
  //         nahi karta, message skip ho jata.
  // Fix:   classifyTiming() se ±60s ka present-window use karo. Sirf tab
  //         "Expired" (-1) do jab expiry us window se BAHAR (>60s) guzar
  //         chuka ho. Isi window ke andar "abhi" (present) treat hota hai
  //         → daysDiff untouched (0), template match hoga, message turant
  //         is cycle mein consider hoga — skip nahi hoga.
  // ─────────────────────────────────────────────────────────────────────
  if (daysDiff === 0) {
    const timing = classifyTiming(expiry.getTime(), nowMs);
    if (timing === 'PAST') return -1;
  }

  return daysDiff;
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

// Short inline wording for {days} inside a message — "Today"/"Tomorrow"/
// "Yesterday" for the near cases, "3 days"/"3 days ago" otherwise. Kept
// deliberately shorter than dateFormat.js's formatDaysLabel() (no "before/
// after expiry" suffix) since {days} sits inside the template author's own
// sentence, e.g. "Dear {name}! Days {days}" or "{days} din baaki hain".
const formatDaysLeftInline = (n) => {
  if (n === 0) return 'Today';
  if (n === 1) return 'Tomorrow';
  if (n === -1) return 'Yesterday';
  return n > 0 ? `${n} days` : `${Math.abs(n)} days ago`;
};

export const personalizeMessage = (body, contact, daysLeft) => {
  return body
    .replace(/\{name\}/gi, contact.name ?? '')
    .replace(/\{phone\}/gi, contact.phone_number ?? '')
    .replace(/\{days\}/gi, formatDaysLeftInline(daysLeft))
    .replace(/\{expiry\}/gi, formatPakistanDate(contact.expiry_datetime));
};