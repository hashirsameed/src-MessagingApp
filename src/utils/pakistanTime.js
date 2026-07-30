/**
 * pakistanTime.js
 *
 * The whole app is meant to run on ONE clock — Pakistan Standard Time
 * (Asia/Karachi, UTC+5). Pakistan does not observe daylight saving, so
 * the offset below is a constant, not a timezone-database lookup.
 *
 * Why this file exists: previously the app used the device's own local
 * timezone (via Date.setHours/getHours/toLocaleString without a timeZone
 * option) for computing alarm times and displaying dates. If the phone's
 * system timezone isn't Pakistan, alarms fire at the wrong real-world
 * time and the UI shows the wrong time. Every function here is explicit
 * about being anchored to Pakistan time, independent of the device.
 */

export const PAKISTAN_TIME_ZONE = 'Asia/Karachi';
const PKT_OFFSET_MS = 5 * 60 * 60 * 1000; // UTC+5, fixed, no DST

/**
 * Returns Pakistan wall-clock date/time components for a given instant
 * (defaults to now) — independent of the device's own timezone.
 */
export const toPakistanParts = (date = new Date()) => {
  const shifted = new Date(date.getTime() + PKT_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1, // 1-12
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
  };
};

/**
 * Builds an absolute UTC epoch ms from Pakistan wall-clock components.
 * e.g. pakistanPartsToUtcMs(2026, 7, 4, 17, 0) is the instant that reads
 * as 5:00 PM on 4 July 2026 in Pakistan, regardless of device timezone.
 */
export const pakistanPartsToUtcMs = (year, month, day, hour = 0, minute = 0, second = 0) => {
  const wallClockAsUtcMs = Date.UTC(year, month - 1, day, hour, minute, second);
  return wallClockAsUtcMs - PKT_OFFSET_MS;
};

/** Epoch ms for midnight (00:00) Pakistan time on the given instant's PKT calendar day. */
export const pakistanDayStartMs = (date = new Date()) => {
  const { year, month, day } = toPakistanParts(date);
  return pakistanPartsToUtcMs(year, month, day, 0, 0, 0);
};

/**
 * Formats an ISO/date value as Pakistan date+time, e.g. "04 Jul 2026, 5:00 PM",
 * always in Asia/Karachi regardless of device timezone.
 * @param {boolean} [showSuffix=true]  Append " PKT" to the formatted string.
 */
export const formatPakistanDateTime = (isoOrDate, showSuffix = true) => {
  if (!isoOrDate) return '—';
  const date = typeof isoOrDate === 'string' ? new Date(isoOrDate) : isoOrDate;
  if (Number.isNaN(date.getTime())) return '—';

  const datePart = date.toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: PAKISTAN_TIME_ZONE,
  });
  const timePart = date.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: PAKISTAN_TIME_ZONE,
  });
  return showSuffix ? `${datePart}, ${timePart} PKT` : `${datePart}, ${timePart}`;
};

// Date-only, no time-of-day — for the {expiry} token in outgoing messages.
// Showing a time here was misleading: it isn't the contact's actual expiry
// time, and in the template preview it showed whatever moment you happened
// to be editing at, not the Send Time configured above. The date alone is
// what a customer actually needs.
export const formatPakistanDate = (isoOrDate) => {
  if (!isoOrDate) return '—';
  const date = typeof isoOrDate === 'string' ? new Date(isoOrDate) : isoOrDate;
  if (Number.isNaN(date.getTime())) return '—';

  return date.toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: PAKISTAN_TIME_ZONE,
  });
};