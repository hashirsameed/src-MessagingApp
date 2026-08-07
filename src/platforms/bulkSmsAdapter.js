import { sendBulkSms, hasBulkSmsCredentials } from '../utils/bulkSmsService';
import { debugTrace } from '../utils/debugTrace';
import { registerAdapter } from './registry';

/**
 * dispatch — handles platform_type = 'bulk_remote' (generic bulk SMS API).
 * ctx = { bulkSmsConfigured, traceContext, dryRun }
 *
 * Distinct from the device SMS platform ('sms', platform_type='local_text',
 * localTextAdapter.js — native SmsManager). This is a separate platform row
 * (e.g. id='sms_bulk') so its own rate-limit tier and pacing are tracked
 * independently, keyed by its own platform_id — see queueUtils.resolveRateLimits.
 *
 * Result contract mirrors whatsappAdapter.js exactly, so queueProcessor's
 * normalizeDispatchResult() handles both without any extra branching:
 *   { status: 'sent' }
 *   { status: 'rate_limited_BULK', retryAfterMs: number|null }
 *   { status: 'failed_permanent', reason: string }
 *
 * Rate-limited is NOT a permanent failure — queueProcessor reverts it to
 * PENDING and arms a retry-alarm, same pattern as WhatsApp/device SMS.
 *
 * DRY RUN — when ctx.dryRun is true, the `bulkSmsConfigured` check above
 * still runs for real (so a dry-run batch can still exercise the
 * BULK_SMS_NOT_CONFIGURED failure path), but the actual gateway `fetch()`
 * call inside sendBulkSms is skipped entirely — a synthetic 'sent' result
 * is returned instead. This is the only thing standing between a Testing
 * Lab bulk-send and a real bulk SMS API call (and the cost/PTA-threshold
 * consequences that come with it) going out.
 */
export const dispatch = async (platform, contact, message, ctx = {}) => {
  const { bulkSmsConfigured = false, traceContext = {}, dryRun = false } = ctx;

  if (!bulkSmsConfigured) {
    debugTrace('DispatchItemExit', {
      ...traceContext, platformId: platform.id, exitReason: 'bulk_sms_not_configured',
      result: 'failed_permanent:BULK_SMS_NOT_CONFIGURED',
    });
    return { status: 'failed_permanent', reason: 'BULK_SMS_NOT_CONFIGURED' };
  }

  if (dryRun) {
    debugTrace('DispatchItemExit', {
      ...traceContext, platformId: platform.id, outcome: 'sent', result: 'DRY_RUN_SIMULATED_SENT',
    });
    return { status: 'sent' };
  }

  debugTrace('BulkSmsRequestBefore', { ...traceContext, contactId: contact.id, phone: contact.phone_number });
  const result = await sendBulkSms(contact.phone_number ?? '', message, traceContext);
  debugTrace('BulkSmsRequestAfter', {
    ...traceContext, contactId: contact.id, success: result.success, error: result.error ?? '',
    httpStatus: result.httpStatus ?? 'none',
  });

  if (result.success) {
    debugTrace('DispatchItemExit', { ...traceContext, platformId: platform.id, outcome: 'sent' });
    return { status: 'sent' };
  }

  if (result.error === 'RATE_LIMITED') {
    debugTrace('DispatchItemExit', {
      ...traceContext, platformId: platform.id, outcome: 'rate_limited',
      httpStatus: result.httpStatus ?? 'none', retryAfterMs: result.retryAfterMs ?? 'none',
    });
    return { status: 'rate_limited_BULK', retryAfterMs: result.retryAfterMs ?? null };
  }

  const reason = `BULK_${(result.error ?? 'UNKNOWN').toString().replace(/\s+/g, '_').toUpperCase()}`;
  debugTrace('DispatchItemExit', { ...traceContext, platformId: platform.id, outcome: 'failed', result: reason });
  return { status: 'failed_permanent', reason };
};

// isConfigured — exposed so queueProcessor can compute ctx.bulkSmsConfigured
// once per run, same pattern as hasWhatsAppCredentials().
export const isConfigured = hasBulkSmsCredentials;

export default { dispatch, isConfigured };

registerAdapter('bulk_remote', { dispatch, isConfigured });