export const validatePhoneNumber = (phone) => {
  // Pakistan phone numbers: 03XXXXXXXXX (11 digits)
  const regex = /^03[0-9]{9}$/;
  if (!phone.trim()) return { valid: false, message: 'Phone number is required.' };
  if (!regex.test(phone)) return { valid: false, message: 'Invalid phone number. Format: 03XXXXXXXXX' };
  return { valid: true, message: '' };
};

export const validateName = (name) => {
  if (!name.trim()) return { valid: false, message: 'Name is required.' };
  if (name.trim().length < 2) return { valid: false, message: 'Name must be at least 2 characters.' };
  return { valid: true, message: '' };
};

export const validateDate = (date) => {
  const regex = /^\d{4}-\d{2}-\d{2}$/;
  if (!date.trim()) return { valid: false, message: 'Expiry date is required.' };
  if (!regex.test(date)) return { valid: false, message: 'Invalid format. Use YYYY-MM-DD (e.g. 2026-12-31)' };
  const parsed = new Date(date);
  if (isNaN(parsed.getTime())) return { valid: false, message: 'Invalid date.' };
  return { valid: true, message: '' };
};

export const validateTime = (time) => {
  // 12-hour HH:MM, e.g. 9:00, 02:30
  const regex = /^((0?[1-9])|(1[0-2])):([0-5]\d)$/;
  if (!time.trim()) return { valid: false, message: 'Expiry time is required.' };
  if (!regex.test(time.trim())) return { valid: false, message: 'Invalid format. Use HH:MM (12-hour, e.g. 2:30)' };
  return { valid: true, message: '' };
};

export const validateTemplateTitle = (title) => {
  if (!title.trim()) return { valid: false, message: 'Template title is required.' };
  if (title.trim().length < 3) return { valid: false, message: 'Title must be at least 3 characters.' };
  return { valid: true, message: '' };
};

export const validateTemplateBody = (body) => {
  if (!body.trim()) return { valid: false, message: 'Message body is required.' };
  if (body.trim().length < 5) return { valid: false, message: 'Message body is too short.' };
  return { valid: true, message: '' };
};

export const validateUrlScheme = (url) => {
  if (!url.trim()) return { valid: false, message: 'URL scheme is required.' };
  if (!url.includes('{phone}')) return { valid: false, message: 'URL scheme must contain {phone} placeholder.' };
  if (!url.includes('{message}')) return { valid: false, message: 'URL scheme must contain {message} placeholder.' };
  return { valid: true, message: '' };
};

export const validateOptionalTime = (time) => {
  if (!time || !time.trim()) return { valid: true, message: '' };
  return validateTime(time);
};

/**
 * Validate template days_before field. Accepts any integer (positive, zero,
 * or negative) — negative values mean "after expiry," which is valid for
 * follow-up/catch-up templates. Returns null instead of the standard
 * {valid, message} shape so callers can do a simple truthy check:
 *   const err = validateTemplateDays(daysBefore); if (err) { ... }
 */
export const validateTemplateDays = (daysBefore) => {
  const trimmed = (daysBefore ?? '').toString().trim();
  if (!trimmed) return 'Days before expiry is required.';
  const parsed = parseInt(trimmed, 10);
  if (isNaN(parsed)) return 'Days before expiry must be a valid number.';
  return null; // valid
};
