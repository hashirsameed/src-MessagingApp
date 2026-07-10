import { sendWhatsAppMessage, hasWhatsAppCredentials } from '../utils/whatsappService';
import { debugTrace } from '../utils/debugTrace';
import { registerAdapter } from './registry';

const formatPhone = (phone) => {
  const cleaned = phone.replace(/\D/g, '').replace(/^0/, '');
  return `92${cleaned}`;
};

/**
 * dispatch — handles platform_type = 'managed_remote' (WhatsApp / Meta Cloud API).
 * ctx = { waConfigured, traceContext }
 * Same result vocabulary as localTextAdapter: 'sent' | 'failed_<REASON>'.
 * All real send logic still lives in whatsappService.js — untouched.
 */
export const dispatch = async (platform, contact, message, ctx = {}) => {
  const { waConfigured = false, traceContext = {} } = ctx;

  if (!waConfigured) {
    debugTrace('DispatchItemExit', {
      ...traceContext, platformId: 'whatsapp', exitReason: 'whatsapp_not_configured',
      result: 'failed_WHATSAPP_NOT_CONFIGURED',
    });
    return 'failed_WHATSAPP_NOT_CONFIGURED';
  }

  const phone = formatPhone(contact.phone_number ?? '');
  debugTrace('WhatsAppRequestBefore', { ...traceContext, contactId: contact.id, phone });
  const result = await sendWhatsAppMessage(phone, message, traceContext);
  debugTrace('WhatsAppRequestAfter', {
    ...traceContext, contactId: contact.id, success: result.success, error: result.error ?? '',
  });

  if (result.success) {
    debugTrace('DispatchItemExit', { ...traceContext, platformId: 'whatsapp', outcome: 'sent' });
    return 'sent';
  }

  const failResult = `failed_WA_${(result.error ?? 'UNKNOWN').replace(/\s+/g, '_').toUpperCase()}`;
  debugTrace('DispatchItemExit', { ...traceContext, platformId: 'whatsapp', outcome: 'failed', result: failResult });
  return failResult;
};

// isConfigured — exposed so queueProcessor (Step 5) can compute ctx.waConfigured
// once per run, same as it does today with hasWhatsAppCredentials().
export const isConfigured = hasWhatsAppCredentials;

export default { dispatch, isConfigured };

registerAdapter('managed_remote', { dispatch, isConfigured });