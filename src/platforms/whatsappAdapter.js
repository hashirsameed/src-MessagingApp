import { sendWhatsAppMessage, hasWhatsAppCredentials } from '../utils/whatsappService';
import { debugTrace } from '../utils/debugTrace';
import { registerAdapter } from './registry';

const formatPhone = (phone) => {
  const cleaned = phone.replace(/\D/g, '').replace(/^0/, '');
  return `92${cleaned}`;
};

// ─────────────────────────────────────────────────────────────────────────────
// Rate-limit classification
// Meta signals throttling via HTTP 429 and/or error.code === 130429 (both
// confirmed in Meta's own Cloud API error responses). The message-text
// fallback below is deliberately loose — it catches other rate/throughput
// wording Meta may use that isn't captured by a specific numeric code —
// rather than hardcoding additional numeric subcodes that haven't been
// independently verified.
// ─────────────────────────────────────────────────────────────────────────────
const isRateLimitedResponse = (result) => {
  if (result.httpStatus === 429) return true;
  if (result.code === 130429) return true;
  const msg = (result.error ?? '').toLowerCase();
  return msg.includes('rate limit') || msg.includes('too many requests');
};

/**
 * dispatch — handles platform_type = 'managed_remote' (WhatsApp / Meta Cloud API).
 * ctx = { waConfigured, traceContext, template, dryRun }
 * `template.meta_template_name`/`meta_template_language` (set when the
 * schedule was created — see CreateTemplateScreen) tell sendWhatsAppMessage
 * which specific APPROVED Meta template to use; contact.name fills its
 * single {{1}} parameter.
 *
 * Result contract (object, not a bare string — see queueProcessor.js's
 * dispatchItem() normalization for how this coexists with localTextAdapter's
 * plain-string contract):
 *   { status: 'sent' }
 *   { status: 'rate_limited_WA', retryAfterMs: number|null }
 *   { status: 'failed_permanent', reason: string }
 *
 * The rate-limited case is intentionally NOT treated as a permanent failure
 * — queueProcessor reverts it to PENDING and arms a retry-alarm, same
 * pattern as the local SMS rate limit, instead of marking it FAILED forever.
 *
 * DRY RUN — when ctx.dryRun is true, the `waConfigured` check above still
 * runs for real (so a dry-run batch can still exercise the
 * WHATSAPP_NOT_CONFIGURED failure path), but the actual Meta Cloud API
 * `fetch()` call inside sendWhatsAppMessage is skipped entirely — a
 * synthetic 'sent' result is returned instead. This is the only thing
 * standing between a Testing Lab bulk-send and a real WhatsApp message
 * going out to a real number.
 */
export const dispatch = async (platform, contact, message, ctx = {}) => {
  const { waConfigured = false, traceContext = {}, template = null, dryRun = false } = ctx;

  if (!waConfigured) {
    debugTrace('DispatchItemExit', {
      ...traceContext, platformId: 'whatsapp', exitReason: 'whatsapp_not_configured',
      result: 'failed_permanent:WHATSAPP_NOT_CONFIGURED',
    });
    return { status: 'failed_permanent', reason: 'WHATSAPP_NOT_CONFIGURED' };
  }

  if (dryRun) {
    debugTrace('DispatchItemExit', {
      ...traceContext, platformId: 'whatsapp', outcome: 'sent', result: 'DRY_RUN_SIMULATED_SENT',
    });
    return { status: 'sent' };
  }

  const phone = formatPhone(contact.phone_number ?? '');
  debugTrace('WhatsAppRequestBefore', { ...traceContext, contactId: contact.id, phone });
  const result = await sendWhatsAppMessage(
    phone, message, traceContext,
    template?.meta_template_name ?? null,
    template?.meta_template_language ?? null,
    contact.name ?? null,
  );
  debugTrace('WhatsAppRequestAfter', {
    ...traceContext, contactId: contact.id, success: result.success, error: result.error ?? '',
    httpStatus: result.httpStatus ?? 'none', code: result.code ?? 'none',
  });

  if (result.success) {
    debugTrace('DispatchItemExit', { ...traceContext, platformId: 'whatsapp', outcome: 'sent' });
    return { status: 'sent' };
  }

  if (isRateLimitedResponse(result)) {
    debugTrace('DispatchItemExit', {
      ...traceContext, platformId: 'whatsapp', outcome: 'rate_limited',
      httpStatus: result.httpStatus ?? 'none', code: result.code ?? 'none',
      retryAfterMs: result.retryAfterMs ?? 'none',
    });
    return { status: 'rate_limited_WA', retryAfterMs: result.retryAfterMs ?? null };
  }

  const reason = `WA_${(result.error ?? 'UNKNOWN').replace(/\s+/g, '_').toUpperCase()}`;
  debugTrace('DispatchItemExit', { ...traceContext, platformId: 'whatsapp', outcome: 'failed', result: reason });
  return { status: 'failed_permanent', reason };
};

// isConfigured — exposed so queueProcessor (Step 5) can compute ctx.waConfigured
// once per run, same as it does today with hasWhatsAppCredentials().
export const isConfigured = hasWhatsAppCredentials;

export default { dispatch, isConfigured };

registerAdapter('managed_remote', { dispatch, isConfigured });