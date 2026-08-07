/**
 * bulkSmsService.js
 *
 * GENERIC bulk SMS gateway integration — deliberately provider-agnostic for
 * now. Stores an API URL + API key + optional sender ID, and POSTs a plain
 * JSON body { to, message, sender_id } with `Authorization: Bearer <apiKey>`.
 *
 * This is intentionally the lowest-common-denominator shape most bulk SMS
 * gateways accept (Twilio, Vonage, local/regional gateways, etc. all differ
 * in field names/auth style). When a specific provider is chosen, only
 * buildRequestBody() / buildHeaders() / parseResponse() below need to
 * change — everything upstream (bulkSmsAdapter.js, queueProcessor.js,
 * rate-limit resolution) is provider-shape-agnostic and won't need touching.
 *
 * Credential storage format mirrors whatsappService.js:
 *   - username: 'bulk_sms_creds' (fixed marker)
 *   - password: JSON.stringify({ apiUrl, apiKey, senderId })
 */

import * as Keychain from 'react-native-keychain';
import { handleError } from './errorHandler';
import { debugTrace } from './debugTrace';

const KEYCHAIN_SERVICE = 'bulk_sms_credentials';
const CREDS_MARKER = 'bulk_sms_creds';

// ---------------------------------------------------------------------------
// Credential storage (Keychain)
// ---------------------------------------------------------------------------

/**
 * @param {string} apiUrl    Full endpoint URL the provider expects POSTs at.
 * @param {string} apiKey    Sent as `Authorization: Bearer <apiKey>`.
 * @param {string} [senderId] Optional — included in the request body as `sender_id` if given.
 */
export const saveBulkSmsCredentials = async (apiUrl, apiKey, senderId = null) => {
  try {
    const payload = { apiUrl, apiKey, senderId };
    await Keychain.setGenericPassword(CREDS_MARKER, JSON.stringify(payload), { service: KEYCHAIN_SERVICE });
    return true;
  } catch (error) {
    handleError(error, 'saveBulkSmsCredentials');
    return false;
  }
};

/**
 * @returns {Promise<{ apiUrl: string, apiKey: string, senderId: string|null } | null>}
 */
export const getBulkSmsCredentials = async () => {
  try {
    const result = await Keychain.getGenericPassword({ service: KEYCHAIN_SERVICE });
    if (!result || result.username !== CREDS_MARKER) return null;
    const parsed = JSON.parse(result.password);
    return {
      apiUrl: parsed.apiUrl,
      apiKey: parsed.apiKey,
      senderId: parsed.senderId ?? null,
    };
  } catch (error) {
    handleError(error, 'getBulkSmsCredentials');
    return null;
  }
};

export const hasBulkSmsCredentials = async () => {
  const creds = await getBulkSmsCredentials();
  return creds !== null && !!creds.apiUrl && !!creds.apiKey;
};

export const clearBulkSmsCredentials = async () => {
  try {
    await Keychain.resetGenericPassword({ service: KEYCHAIN_SERVICE });
    return true;
  } catch (error) {
    handleError(error, 'clearBulkSmsCredentials');
    return false;
  }
};

// ---------------------------------------------------------------------------
// Generic HTTP send — swap this section out when the real provider is picked
// ---------------------------------------------------------------------------

// PROVIDER CUSTOMIZATION POINT — request body shape.
const buildRequestBody = (toPhone, message, senderId) => ({
  to: toPhone,
  message,
  ...(senderId ? { sender_id: senderId } : {}),
});

// PROVIDER CUSTOMIZATION POINT — auth/header shape.
const buildHeaders = (apiKey) => ({
  'Authorization': `Bearer ${apiKey}`,
  'Content-Type': 'application/json',
});

// PROVIDER CUSTOMIZATION POINT — most gateways signal throttling via HTTP
// 429, but some use a 200 + an in-body error code instead. Extend this if
// the chosen provider does the latter.
const isRateLimitedResponse = (httpStatus, data) => {
  if (httpStatus === 429) return true;
  const msg = (data?.error ?? data?.message ?? '').toString().toLowerCase();
  return msg.includes('rate limit') || msg.includes('too many requests');
};

/**
 * Send one SMS through the configured bulk gateway.
 *
 * @returns {Promise<{ success: boolean, error?: string, httpStatus?: number|null, retryAfterMs?: number|null }>}
 */
export const sendBulkSms = async (toPhone, message, traceContext = {}) => {
  debugTrace('SendBulkSmsStart', { ...traceContext, toPhone, messageLength: message?.length ?? 0 });

  const creds = await getBulkSmsCredentials();
  if (!creds) {
    debugTrace('SendBulkSmsExit', { ...traceContext, exitReason: 'no_credentials', success: false });
    return { success: false, error: 'NO_CREDENTIALS', httpStatus: null, retryAfterMs: null };
  }

  try {
    const response = await fetch(creds.apiUrl, {
      method: 'POST',
      headers: buildHeaders(creds.apiKey),
      body: JSON.stringify(buildRequestBody(toPhone, message, creds.senderId)),
    });

    let data = null;
    try {
      data = await response.json();
    } catch {
      // Some gateways return a plain-text/empty body on success — not fatal.
      data = null;
    }

    debugTrace('SendBulkSmsHttpResponse', { ...traceContext, httpStatus: response.status, ok: response.ok });

    if (!response.ok) {
      const retryAfterHeader = response.headers?.get?.('Retry-After');
      const retryAfterMs = retryAfterHeader && !isNaN(Number(retryAfterHeader))
        ? Number(retryAfterHeader) * 1000
        : null;

      if (isRateLimitedResponse(response.status, data)) {
        return { success: false, error: 'RATE_LIMITED', httpStatus: response.status, retryAfterMs };
      }

      const errMsg = data?.error ?? data?.message ?? `HTTP_${response.status}`;
      return { success: false, error: errMsg, httpStatus: response.status, retryAfterMs: null };
    }

    debugTrace('SendBulkSmsExit', { ...traceContext, success: true });
    return { success: true, httpStatus: response.status, retryAfterMs: null };
  } catch (error) {
    handleError(error, 'sendBulkSms');
    return { success: false, error: 'NETWORK_ERROR', httpStatus: null, retryAfterMs: null };
  }
};