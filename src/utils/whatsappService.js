/**
 * whatsappService.js
 *
 * Handles:
 * 1. Storing / retrieving Meta WhatsApp API credentials via react-native-keychain
 * 2. Sending a WhatsApp message via Meta Cloud API (fully automatic, no tap needed)
 *
 * Credential storage format (v2, backward-compatible):
 *   - username: 'whatsapp_creds' (fixed marker for new JSON format)
 *   - password: JSON.stringify({ accessToken, phoneNumberId, businessAccountId })
 *
 * Legacy format (v1, still read transparently):
 *   - username: phoneNumberId
 *   - password: accessToken
 *   - businessAccountId: not available, returns null
 */

import * as Keychain from 'react-native-keychain';
import { handleError, handleRecoverableError } from './errorHandler';
import { debugTrace, debugTraceError, debugTraceRecoverable } from './debugTrace';

const KEYCHAIN_SERVICE = 'whatsapp_meta_credentials';
const META_API_VERSION = 'v25.0';
const NEW_FORMAT_MARKER = 'whatsapp_creds';

// ---------------------------------------------------------------------------
// DEV MODE
// ---------------------------------------------------------------------------
// When true, sendWhatsAppMessage() ignores the real message text and always
// sends Meta's pre-approved "hello_world" template instead. This exists
// because Meta only allows freeform/custom text templates AFTER they've been
// submitted and approved in the WhatsApp Business Manager; until that
// approval lands, "hello_world" is the only template guaranteed to send
// successfully, which makes it useful for verifying the API/credentials
// wiring end-to-end during development.
//
// MUST be set to false before shipping to production — otherwise every
// WhatsApp send will silently go out as "hello_world" instead of the
// user's actual personalized message.
const DEV_MODE = false;

const DEV_TEMPLATE_NAME = 'hello_world';
const DEV_TEMPLATE_LANGUAGE = 'en_US';

// ---------------------------------------------------------------------------
// Credential storage (Keychain) — backward-compatible
// ---------------------------------------------------------------------------

/**
 * Save WhatsApp Meta API credentials securely.
 * Always writes in the new JSON format going forward.
 *
 * @param {string} accessToken
 * @param {string} phoneNumberId
 * @param {string} [businessAccountId]  Optional — needed for template management
 */
export const saveWhatsAppCredentials = async (accessToken, phoneNumberId, businessAccountId = null) => {
  try {
    const credentialsPayload = {
      accessToken,
      phoneNumberId,
      businessAccountId,
    };

    await Keychain.setGenericPassword(
      NEW_FORMAT_MARKER,
      JSON.stringify(credentialsPayload),
      { service: KEYCHAIN_SERVICE },
    );
    return true;
  } catch (error) {
    handleError(error, 'saveWhatsAppCredentials');
    return false;
  }
};

/**
 * Retrieve stored credentials. Transparently handles both the new JSON
 * format and the legacy plain username/password format so existing
 * installs don't lose their saved credentials after this update.
 *
 * @returns {Promise<{ accessToken: string, phoneNumberId: string, businessAccountId: string|null } | null>}
 */
export const getWhatsAppCredentials = async () => {
  try {
    const result = await Keychain.getGenericPassword({ service: KEYCHAIN_SERVICE });
    if (!result) return null;

    // Legacy format: username was the phoneNumberId, password was the raw token
    if (result.username !== NEW_FORMAT_MARKER) {
      return {
        accessToken: result.password,
        phoneNumberId: result.username,
        businessAccountId: null,
      };
    }

    // New format: password holds a JSON payload
    try {
      const parsed = JSON.parse(result.password);
      return {
        accessToken: parsed.accessToken,
        phoneNumberId: parsed.phoneNumberId,
        businessAccountId: parsed.businessAccountId ?? null,
      };
    } catch (jsonError) {
      handleError(jsonError, 'getWhatsAppCredentials.jsonParse');
      return null;
    }
  } catch (error) {
    handleError(error, 'getWhatsAppCredentials');
    return null;
  }
};

/**
 * Check if minimal required credentials exist (sending only).
 * businessAccountId is intentionally NOT required here — legacy users
 * and users who only want sending (not template management) stay unaffected.
 */
export const hasWhatsAppCredentials = async () => {
  debugTrace('HasWhatsAppCredentialsCheckBefore', {});
  const creds = await getWhatsAppCredentials();
  const configured = creds !== null && !!creds.accessToken && !!creds.phoneNumberId;
  debugTrace('HasWhatsAppCredentialsCheckAfter', { configured });
  return configured;
};

/**
 * Check if Business Account ID is configured — required specifically
 * for template management features (fetch/create templates).
 */
export const hasBusinessAccountId = async () => {
  const creds = await getWhatsAppCredentials();
  return creds !== null && !!creds.businessAccountId;
};

/**
 * Delete stored credentials.
 */
export const clearWhatsAppCredentials = async () => {
  try {
    await Keychain.resetGenericPassword({ service: KEYCHAIN_SERVICE });
    return true;
  } catch (error) {
    handleError(error, 'clearWhatsAppCredentials');
    return false;
  }
};

// ---------------------------------------------------------------------------
// Meta Cloud API — Send Message
// ---------------------------------------------------------------------------

/**
 * Builds the request body for Meta's /messages endpoint.
 *
 * - DEV_MODE=true            -> always the approved "hello_world" template,
 *                                regardless of anything else. Sanity-checks
 *                                API/credentials wiring only.
 * - metaTemplateName given   -> sends that specific APPROVED template, with
 *                                one body parameter (paramValue — typically
 *                                the contact's name, matching the {{1}} used
 *                                across the app's WhatsApp templates so far).
 * - neither                  -> falls back to freeform text. Meta only
 *                                allows this within an open 24h customer
 *                                service window; outside that window this
 *                                call will be rejected.
 */
const buildMessageBody = (toPhone, message, metaTemplateName = null, metaTemplateLanguage = null, paramValue = null) => {
  if (DEV_MODE) {
    return {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: toPhone,
      type: 'template',
      template: {
        name: DEV_TEMPLATE_NAME,
        language: { code: DEV_TEMPLATE_LANGUAGE },
      },
    };
  }

  if (metaTemplateName) {
    return {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: toPhone,
      type: 'template',
      template: {
        name: metaTemplateName,
        language: { code: metaTemplateLanguage || 'en_US' },
        // Single body parameter — every scheduled WhatsApp template built
        // through the app so far uses one {{1}} placeholder for the
        // contact's name. Multi-parameter templates aren't supported yet.
        components: paramValue != null
          ? [{ type: 'body', parameters: [{ type: 'text', text: String(paramValue) }] }]
          : [],
      },
    };
  }

  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: toPhone,
    type: 'text',
    text: { body: message },
  };
};

/**
 * Send a WhatsApp message via Meta Cloud API. Fully automatic — no user
 * tap required.
 *
 * See DEV_MODE above: while DEV_MODE is true, everything below is ignored
 * and the "hello_world" template is sent instead. Once DEV_MODE is off,
 * pass metaTemplateName/metaTemplateLanguage (from the template's schedule
 * row) to send that specific approved template instead of freeform text.
 *
 * @param {string} toPhone  Recipient phone with country code, no +, e.g. "923001234567"
 * @param {string} message  Plain text message body (used only if no metaTemplateName)
 * @param {object} [traceContext]
 * @param {string} [metaTemplateName]
 * @param {string} [metaTemplateLanguage]
 * @param {string} [paramValue]  Value for the template's {{1}} — usually contact.name
 * @returns {Promise<{ success: boolean, error?: string }>}
 */
export const sendWhatsAppMessage = async (
  toPhone, message, traceContext = {}, metaTemplateName = null, metaTemplateLanguage = null, paramValue = null,
) => {
  debugTrace('SendWhatsAppMessageStart', {
    ...traceContext,
    toPhone,
    messageLength: message?.length ?? 0,
    devMode: DEV_MODE,
    metaTemplateName: metaTemplateName ?? 'none',
  });
  try {
    if (DEV_MODE) {
      debugTrace('SendWhatsAppMessageDevMode', {
        ...traceContext,
        note: 'sending_hello_world_template_instead_of_real_message',
      });
    }

    debugTrace('GetWhatsAppCredentialsBefore', { ...traceContext });
    const creds = await getWhatsAppCredentials();
    debugTrace('GetWhatsAppCredentialsAfter', {
      ...traceContext,
      hasCredentials: !!creds,
    });
    if (!creds) {
      debugTrace('SendWhatsAppMessageExit', {
        ...traceContext,
        exitReason: 'no_credentials',
        success: false,
      });
      return { success: false, error: 'NO_CREDENTIALS' };
    }

    const { accessToken, phoneNumberId } = creds;

    const url = `https://graph.facebook.com/${META_API_VERSION}/${phoneNumberId}/messages`;
    const body = buildMessageBody(toPhone, message, metaTemplateName, metaTemplateLanguage, paramValue);

    debugTrace('WhatsAppHttpRequestBefore', {
      ...traceContext,
      url,
      bodyType: body.type,
    });
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    debugTrace('WhatsAppHttpResponseAfter', {
      ...traceContext,
      httpStatus: response.status,
      ok: response.ok,
    });

    debugTrace('WhatsAppJsonParseBefore', { ...traceContext });
    const data = await response.json();
    debugTrace('WhatsAppJsonParseAfter', {
      ...traceContext,
      hasError: !!data?.error,
      errorMessage: data?.error?.message ?? '',
    });

    if (!response.ok) {
      const errMsg = data?.error?.message ?? `HTTP_${response.status}`;
      debugTrace('SendWhatsAppMessageExit', {
        ...traceContext,
        exitReason: 'http_error',
        success: false,
        error: errMsg,
      });
      return { success: false, error: errMsg };
    }

    debugTrace('SendWhatsAppMessageExit', {
      ...traceContext,
      outcome: 'success',
      success: true,
    });
    return { success: true };
  } catch (error) {
    // This is the actual send-time network failure — no internet, DNS
    // hiccup, etc. queueProcessor already handles a failed send gracefully
    // (marks the item failed, keeps processing the rest of the queue), so
    // this shouldn't pop LogBox's red screen over a background auto-send
    // that recovers fine on its own.
    debugTraceRecoverable('SendWhatsAppMessageCatch', error, {
      function: 'sendWhatsAppMessage',
      ...traceContext,
      toPhone,
    });
    handleRecoverableError(error, 'sendWhatsAppMessage');
    debugTrace('SendWhatsAppMessageExit', {
      ...traceContext,
      exitReason: 'network_error',
      success: false,
      error: error.message ?? 'NETWORK_ERROR',
    });
    return { success: false, error: error.message ?? 'NETWORK_ERROR' };
  }
};

/**
 * Test connection with current credentials by hitting the phone number info endpoint.
 * @returns {Promise<{ success: boolean, displayName?: string, error?: string }>}
 */
export const testWhatsAppConnection = async () => {
  try {
    const creds = await getWhatsAppCredentials();
    if (!creds) return { success: false, error: 'NO_CREDENTIALS' };

    const { accessToken, phoneNumberId } = creds;
    const url = `https://graph.facebook.com/${META_API_VERSION}/${phoneNumberId}?fields=verified_name,quality_rating`;

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    const data = await response.json();

    if (!response.ok) {
      return { success: false, error: data?.error?.message ?? `HTTP_${response.status}` };
    }

    return {
      success: true,
      displayName: data.verified_name ?? data.display_phone_number ?? 'Connected',
    };
  } catch (error) {
    handleRecoverableError(error, 'testWhatsAppConnection');
    return { success: false, error: error.message ?? 'NETWORK_ERROR' };
  }
};
