import { useMemo } from 'react';
import { personalizeMessage } from '../utils/templateMatcher';

/**
 * Shared hook used by both CreateTemplateScreen and EditTemplateScreen
 * to compute the preview message body. Eliminates the duplicate
 * previewDaysBefore / previewSampleContact / previewBodyText logic.
 *
 * @param {string}  body        Raw template body with {name}/{days} tokens
 * @param {string}  daysBefore  Raw days_before string from the form field
 * @returns {{ previewDaysBefore: number, previewBodyText: string }}
 */
export default function useTemplatePreview(body, daysBefore) {
  return useMemo(() => {
    const d = parseInt(daysBefore, 10);
    const previewDaysBefore = isNaN(d) ? 0 : d;
    const previewSampleContact = {
      name: 'John Doe',
      phone_number: '0300-1234567',
      expiry_datetime: new Date(Date.now() + previewDaysBefore * 24 * 60 * 60 * 1000).toISOString(),
    };
    const previewBodyText = (body ?? '').trim()
      ? personalizeMessage(body, previewSampleContact, previewDaysBefore)
      : 'Message body will appear here...';
    return { previewDaysBefore, previewBodyText };
  }, [body, daysBefore]);
}
