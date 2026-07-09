import { PAKISTAN_TIME_ZONE } from './pakistanTime';

export const formatDateTime12Hour = (iso) => {
  if (!iso) return '—';

  const date = new Date(iso);
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

  return `${datePart}, ${timePart}`;
};

export const formatExpiryDate12Hour = (iso) => formatDateTime12Hour(iso);

export const formatTemplateSendTime = (time24) => {
  if (!time24) return 'At expiry time';

  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time24);
  if (!match) return 'At expiry time';

  let hours = parseInt(match[1], 10);
  const minutes = match[2];
  const meridiem = hours >= 12 ? 'PM' : 'AM';

  if (hours === 0) hours = 12;
  else if (hours > 12) hours -= 12;

  return `${hours}:${minutes} ${meridiem}`;
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