import { formatPakistanDateTime } from './pakistanTime';

/**
 * Normalize a date-like input to a UTC ISO string with zero-millisecond
 * precision ("YYYY-MM-DDTHH:mm:ssZ"). Used by all DB write paths so stored
 * timestamps are consistent and sortable via datetime().
 */
export const toUTCISOString = (input) => {
  const d = input instanceof Date ? input : new Date(input);
  if (isNaN(d.getTime())) {
    throw new Error(`Invalid datetime value: ${input}`);
  }
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
};

/**
 * Format an ISO UTC string to Pakistan date+time, e.g. "04 Jul 2026, 5:00 PM".
 * Delegates to formatPakistanDateTime() without the " PKT" suffix.
 */
export const formatDateTime12Hour = (iso) => formatPakistanDateTime(iso, false);

/**
 * Common near-day labels shared by formatDaysLabel (screens) and
 * formatDaysLeftInline (template body tokens). Returns null for non-near days
 * so each caller can apply its own far-day wording.
 */
export const formatNearDay = (n) => {
  if (n === 0) return 'Today';
  if (n === 1) return 'Tomorrow';
  if (n === -1) return 'Yesterday';
  return null;
};

export const split24HourTimeTo12Hour = (time24) => {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time24 ?? '');
  if (!match) return { time: '', meridiem: null };

  let hours = parseInt(match[1], 10);
  const minutes = match[2];
  const meridiem = hours >= 12 ? 'PM' : 'AM';

  if (hours === 0) hours = 12;
  else if (hours > 12) hours -= 12;

  return { time: `${hours}:${minutes}`, meridiem };
};

export const parse12HourTimeTo24Hour = (time, meridiem) => {
  const match = /^((0?[1-9])|(1[0-2])):([0-5]\d)$/.exec((time ?? '').trim());
  if (!match) return null;

  let hours = parseInt(match[1], 10);
  const minutes = match[4];
  const period = (meridiem ?? '').trim().toUpperCase();

  if (period === 'AM') {
    if (hours === 12) hours = 0;
  } else if (period === 'PM') {
    if (hours !== 12) hours += 12;
  } else {
    return null;
  }

  return `${String(hours).padStart(2, '0')}:${minutes}`;
};

export const formatTemplateSendTime = (time24) => {
  if (!time24) return 'At expiry time';
  const parts = split24HourTimeTo12Hour(time24);
  return parts.meridiem ? `${parts.time} ${parts.meridiem}` : 'At expiry time';
};

// n > 0 = days remaining before expiry, n < 0 = days passed after expiry, 0 = expiry day.
export const formatDaysLabel = (daysBefore) => {
  const n = daysBefore ?? 0;
  const near = formatNearDay(n);
  if (near !== null) return near;

  return n > 0
    ? `${n} days before expiry`
    : `${Math.abs(n)} days after expiry`;
};