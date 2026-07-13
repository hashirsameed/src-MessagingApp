/**
 * metaTemplateService.js
 *
 * Handles fetching and creating WhatsApp Message Templates via Meta Graph API.
 * Requires a configured WhatsApp Business Account ID (WABA ID).
 *
 * Error handling philosophy:
 *   - Never throw uncaught — every path returns { success, error/data }
 *   - Network timeouts are bounded (no infinite hang)
 *   - Meta rate limits (HTTP 429) are surfaced distinctly so the UI can
 *     tell the user to wait, instead of showing a generic failure
 *   - Malformed/unexpected JSON from Meta never crashes the caller
 */
import { getWhatsAppCredentials } from './whatsappService';
import { handleError, handleRecoverableError } from './errorHandler';

const META_API_VERSION = 'v25.0';
const REQUEST_TIMEOUT_MS = 15000; // 15s — Meta API can be slow under load

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * fetch() with a hard timeout so the UI never hangs indefinitely
 * if Meta's servers stall or the network drops mid-request.
 */
const fetchWithTimeout = async (url, options) => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    return response;
  } finally {
    clearTimeout(timeoutId);
  }
};

/**
 * Safely parse a fetch Response as JSON. Meta occasionally returns
 * empty bodies or non-JSON error pages (e.g. during outages) — this
 * guarantees callers always get a plain object, never a thrown error.
 */
const safeParseJson = async (response) => {
  try {
    const text = await response.text();
    if (!text) return {};
    return JSON.parse(text);
  } catch (_jsonError) {
    return { _parseError: true };
  }
};

/**
 * Translate a Meta API error response into a stable, UI-friendly reason.
 * Distinguishes rate limiting and auth failures from generic errors so
 * the calling screen can react appropriately (retry-after vs re-auth).
 */
const classifyMetaError = (response, data) => {
  if (response.status === 401 || response.status === 403) {
    return { code: 'AUTH_FAILED', message: data?.error?.message ?? 'Access token invalid or expired.' };
  }
  if (response.status === 429) {
    return { code: 'RATE_LIMITED', message: 'Meta API rate limit reached. Please wait and try again.' };
  }
  if (response.status >= 500) {
    return { code: 'META_SERVER_ERROR', message: 'Meta servers are temporarily unavailable.' };
  }
  if (data?._parseError) {
    return { code: 'INVALID_RESPONSE', message: 'Received an unreadable response from Meta.' };
  }
  return {
    code: 'REQUEST_FAILED',
    message: data?.error?.message ?? `HTTP_${response.status}`,
  };
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch all message templates from the WhatsApp Business Account.
 *
 * @returns {Promise<{ success: boolean, templates?: Array, errorCode?: string, error?: string }>}
 */
export const fetchMetaTemplates = async () => {
  try {
    const creds = await getWhatsAppCredentials();
    if (!creds || !creds.accessToken) {
      return { success: false, errorCode: 'NO_CREDENTIALS', error: 'WhatsApp credentials not configured.' };
    }
    if (!creds.businessAccountId) {
      return { success: false, errorCode: 'MISSING_WABA_ID', error: 'WhatsApp Business Account ID not set.' };
    }

    const { accessToken, businessAccountId } = creds;
    const url = `https://graph.facebook.com/${META_API_VERSION}/${businessAccountId}/message_templates?limit=100`;

    let response;
    try {
      response = await fetchWithTimeout(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
      });
    } catch (networkError) {
      const isTimeout = networkError?.name === 'AbortError';
      handleRecoverableError(networkError, 'fetchMetaTemplates.network');
      return {
        success: false,
        errorCode: isTimeout ? 'TIMEOUT' : 'NETWORK_ERROR',
        error: isTimeout ? 'Request timed out. Check your connection.' : 'Could not reach Meta servers.',
      };
    }

    const data = await safeParseJson(response);

    if (!response.ok || data._parseError) {
      const { code, message } = classifyMetaError(response, data);
      return { success: false, errorCode: code, error: message };
    }

    // Defensive: Meta should return data.data as an array; guard against
    // unexpected shapes so the UI never crashes rendering a list.
    const templates = Array.isArray(data?.data) ? data.data : [];

    return { success: true, templates };
  } catch (error) {
    handleError(error, 'fetchMetaTemplates');
    return { success: false, errorCode: 'UNKNOWN_ERROR', error: error.message ?? 'Unexpected error occurred.' };
  }
};

/**
 * Create a new WhatsApp Message Template on Meta via API.
 *
 * Caller is responsible for validating fields against Meta's content
 * rules BEFORE calling this (see metaTemplateValidator.js) — this
 * function focuses purely on the network/transport contract and
 * surfaces whatever Meta's own validation rejects (e.g. duplicate name).
 *
 * @param {Object} templateData
 * @param {string} templateData.name        lowercase_with_underscores
 * @param {string} templateData.category    UTILITY | MARKETING | AUTHENTICATION
 * @param {string} templateData.language    e.g. 'en_US'
 * @param {Array}  templateData.components  BODY / HEADER / FOOTER / BUTTONS
 * @returns {Promise<{ success: boolean, data?: Object, errorCode?: string, error?: string }>}
 */
export const createMetaTemplate = async (templateData) => {
  try {
    const creds = await getWhatsAppCredentials();
    if (!creds || !creds.accessToken) {
      return { success: false, errorCode: 'NO_CREDENTIALS', error: 'WhatsApp credentials not configured.' };
    }
    if (!creds.businessAccountId) {
      return { success: false, errorCode: 'MISSING_WABA_ID', error: 'WhatsApp Business Account ID not set.' };
    }
    if (!templateData?.name || !templateData?.category || !templateData?.language || !templateData?.components) {
      return { success: false, errorCode: 'INVALID_PAYLOAD', error: 'Template is missing required fields.' };
    }

    const { accessToken, businessAccountId } = creds;
    const url = `https://graph.facebook.com/${META_API_VERSION}/${businessAccountId}/message_templates`;

    const formattedName = templateData.name.toLowerCase().trim().replace(/\s+/g, '_');

    let response;
    try {
      response = await fetchWithTimeout(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: formattedName,
          category: templateData.category,
          language: templateData.language,
          components: templateData.components,
        }),
      });
    } catch (networkError) {
      const isTimeout = networkError?.name === 'AbortError';
      handleRecoverableError(networkError, 'createMetaTemplate.network');
      return {
        success: false,
        errorCode: isTimeout ? 'TIMEOUT' : 'NETWORK_ERROR',
        error: isTimeout ? 'Request timed out. Check your connection.' : 'Could not reach Meta servers.',
      };
    }

    const data = await safeParseJson(response);

    if (!response.ok || data._parseError) {
      const { code, message } = classifyMetaError(response, data);
      return { success: false, errorCode: code, error: message };
    }

    return { success: true, data };
  } catch (error) {
    handleError(error, 'createMetaTemplate');
    return { success: false, errorCode: 'UNKNOWN_ERROR', error: error.message ?? 'Unexpected error occurred.' };
  }
};