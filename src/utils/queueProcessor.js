import { Linking, Platform, PermissionsAndroid, NativeModules } from 'react-native';
import {
  claimPendingQueue, markAsSent, markAsFailed, revertToPending,
  countSmsSentInLastHour,
} from '../database/messageQueueDB';
import { getAllContacts } from '../database/contactDB';
import { getAllTemplates } from '../database/templateDB';
import { getAllPlatforms } from '../database/platformDB';
import { getSmsPerHourLimit } from '../database/settingsDB';
import { getDaysUntilExpiry, personalizeMessage } from './templateMatcher';
import { handleError } from './errorHandler';
import { sendWhatsAppMessage, hasWhatsAppCredentials } from './whatsappService';
import { debugTrace, debugTraceError, debugTraceDuration, generateTraceId } from './debugTrace';

const { SmsModule } = NativeModules;

export const FIXED_PLATFORMS = [
  { id: 'sms',      name: 'SMS',      url_scheme: 'sms:{phone}?body={message}' },
  { id: 'whatsapp', name: 'WhatsApp', url_scheme: '' },
  { id: 'email',    name: 'Email',    url_scheme: 'mailto:{email}?subject={subject}&body={message}' },
  { id: 'gmail',    name: 'Gmail',    url_scheme: 'googlegmail://co?to={email}&subject={subject}&body={message}' },
];

const DEFAULT_EMAIL_SUBJECT = 'Important: Policy Renewal Reminder';
const SMS_INTRA_SEND_DELAY_MS = 3500;

const formatPhone = (phone, platformId) => {
  const cleaned = phone.replace(/\D/g, '').replace(/^0/, '');
  return `92${cleaned}`;
};

const buildUrl = (platform, contact, message) => {
  let url = platform.url_scheme;
  if (url.includes('{phone}')) {
    url = url.replace('{phone}', formatPhone(contact.phone_number ?? '', platform.id));
  }
  if (url.includes('{email}')) {
    url = url.replace('{email}', encodeURIComponent(contact.email ?? ''));
  }
  if (url.includes('{subject}')) {
    url = url.replace('{subject}', encodeURIComponent(DEFAULT_EMAIL_SUBJECT));
  }
  if (url.includes('{message}')) {
    url = url.replace('{message}', encodeURIComponent(message));
  }
  return url;
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const requestSmsPermission = async () => {
  debugTrace('RequestSmsPermissionBefore', {});
  try {
    const granted = await PermissionsAndroid.request(
      PermissionsAndroid.PERMISSIONS.SEND_SMS,
      {
        title: 'SMS Permission',
        message: 'This app needs permission to send SMS messages automatically.',
        buttonPositive: 'Allow',
        buttonNegative: 'Deny',
      },
    );
    const isGranted = granted === PermissionsAndroid.RESULTS.GRANTED;
    debugTrace('RequestSmsPermissionAfter', { granted: isGranted, rawResult: granted });
    return isGranted;
  } catch (error) {
    debugTraceError('RequestSmsPermissionCatch', error, { function: 'requestSmsPermission' });
    debugTrace('RequestSmsPermissionAfter', { granted: false, exitReason: 'exception' });
    return false;
  }
};

const sendNativeSms = async (phoneNumber, message, traceContext = {}) => {
  debugTrace('SendNativeSmsBefore', {
    ...traceContext,
    phoneNumber,
    messageLength: message?.length ?? 0,
  });
  if (!SmsModule) {
    debugTrace('SendNativeSmsExit', {
      ...traceContext,
      exitReason: 'native_module_not_linked',
    });
    return { sent: false, reason: 'NATIVE_MODULE_NOT_LINKED' };
  }
  try {
    debugTrace('NativeModuleSendSmsBefore', { ...traceContext, phoneNumber });
    const resultCode = await SmsModule.sendSms(phoneNumber, message);
    debugTrace('NativeModuleSendSmsAfter', {
      ...traceContext,
      phoneNumber,
      resultCode,
    });
    if (resultCode === 'SENT') {
      debugTrace('SendNativeSmsExit', { ...traceContext, outcome: 'sent', resultCode });
      return { sent: true, reason: 'SENT' };
    }
    debugTrace('SendNativeSmsExit', { ...traceContext, outcome: 'failed', resultCode });
    return { sent: false, reason: resultCode || 'UNKNOWN' };
  } catch (error) {
    debugTraceError('SendNativeSmsCatch', error, {
      function: 'sendNativeSms',
      ...traceContext,
      phoneNumber,
    });
    return { sent: false, reason: `EXCEPTION_${error?.message ?? 'UNKNOWN'}` };
  }
};

const sendViaLinking = async (platform, contact, message, traceContext = {}) => {
  const url = buildUrl(platform, contact, message);
  debugTrace('SendViaLinkingBefore', {
    ...traceContext,
    platformId: platform.id,
    urlLength: url.length,
  });
  let supported = false;
  try {
    supported = await Linking.canOpenURL(url);
  } catch (error) {
    debugTraceError('SendViaLinkingCanOpenCatch', error, {
      function: 'sendViaLinking',
      ...traceContext,
      platformId: platform.id,
    });
    supported = false;
  }
  debugTrace('SendViaLinkingCanOpenAfter', {
    ...traceContext,
    platformId: platform.id,
    supported,
  });
  if (!supported) {
    debugTrace('SendViaLinkingExit', {
      ...traceContext,
      platformId: platform.id,
      exitReason: 'url_not_supported',
    });
    return false;
  }
  await Linking.openURL(url);
  debugTrace('SendViaLinkingExit', {
    ...traceContext,
    platformId: platform.id,
    outcome: 'opened',
  });
  return true;
};

const dispatchItem = async (platform, contact, message, smsPermissionGranted, waConfigured, traceContext = {}) => {
  debugTrace('DispatchItemStart', {
    ...traceContext,
    platformId: platform.id,
    contactId: contact.id,
    smsPermissionGranted,
    waConfigured,
  });

  if (platform.id === 'whatsapp') {
    if (!waConfigured) {
      debugTrace('DispatchItemExit', {
        ...traceContext,
        platformId: 'whatsapp',
        exitReason: 'whatsapp_not_configured',
        result: 'failed_WHATSAPP_NOT_CONFIGURED',
      });
      return 'failed_WHATSAPP_NOT_CONFIGURED';
    }
    const phone = formatPhone(contact.phone_number ?? '', 'whatsapp');
    debugTrace('WhatsAppRequestBefore', { ...traceContext, contactId: contact.id, phone });
    const result = await sendWhatsAppMessage(phone, message, traceContext);
    debugTrace('WhatsAppRequestAfter', {
      ...traceContext,
      contactId: contact.id,
      success: result.success,
      error: result.error ?? '',
    });
    if (result.success) {
      debugTrace('DispatchItemExit', { ...traceContext, platformId: 'whatsapp', outcome: 'sent' });
      return 'sent';
    }
    const failResult = `failed_WA_${(result.error ?? 'UNKNOWN').replace(/\s+/g, '_').toUpperCase()}`;
    debugTrace('DispatchItemExit', {
      ...traceContext, platformId: 'whatsapp', outcome: 'failed', result: failResult,
    });
    return failResult;
  }

  if (platform.id === 'sms') {
    if (Platform.OS === 'android') {
      if (!smsPermissionGranted) {
        debugTrace('DispatchItemExit', {
          ...traceContext, platformId: 'sms', exitReason: 'no_sms_permission', result: 'failed_NO_SMS_PERMISSION',
        });
        return 'failed_NO_SMS_PERMISSION';
      }

      const { sent, reason } = await sendNativeSms(contact.phone_number, message, traceContext);
      if (sent) {
        debugTrace('DispatchItemExit', { ...traceContext, platformId: 'sms', outcome: 'sent' });
        return 'sent';
      }

      if (reason === 'NATIVE_MODULE_NOT_LINKED') {
        debugTrace('DispatchItemSmsFallbackLinking', { ...traceContext, reason });
        const opened = await sendViaLinking(platform, contact, message, traceContext);
        const result = opened ? 'opened' : 'failed_SMS_PLATFORM_UNAVAILABLE';
        debugTrace('DispatchItemExit', {
          ...traceContext, platformId: 'sms', outcome: opened ? 'opened' : 'failed', result,
        });
        return result;
      }

      const failResult = `failed_${reason}`;
      debugTrace('DispatchItemExit', { ...traceContext, platformId: 'sms', outcome: 'failed', result: failResult });
      return failResult;
    }

    const opened = await sendViaLinking(platform, contact, message, traceContext);
    const result = opened ? 'opened' : 'failed_SMS_PLATFORM_UNAVAILABLE';
    debugTrace('DispatchItemExit', {
      ...traceContext, platformId: 'sms', outcome: opened ? 'opened' : 'failed', result,
    });
    return result;
  }

  const opened = await sendViaLinking(platform, contact, message, traceContext);
  if (opened) {
    debugTrace('DispatchItemExit', { ...traceContext, platformId: platform.id, outcome: 'opened' });
    return 'opened';
  }
  const failResult = `failed_PLATFORM_NOT_INSTALLED_${platform.id.toUpperCase()}`;
  debugTrace('DispatchItemExit', { ...traceContext, platformId: platform.id, outcome: 'failed', result: failResult });
  return failResult;
};

// ---------------------------------------------------------------------------
// Main export
//
// Signature stays BACKWARD-COMPATIBLE with any existing caller that does
// `processQueue(someProgressCallback)` (e.g. a manual "Process Queue"
// button in QueueScreen.js) — onProgress is still the FIRST parameter.
// parentTraceId is a NEW second parameter: when a caller (like
// AlarmFiredTask) already has a traceId from its own execution, it links
// this run's logs to that parent trace. If omitted, processQueue()
// generates its own traceId so every run — manual, foreground-interval,
// or alarm-triggered — is still uniquely identifiable in the logs.
// ---------------------------------------------------------------------------
export const processQueue = async (onProgress, parentTraceId = null) => {
  const startTime = Date.now();
  const traceId = parentTraceId ?? generateTraceId('processQueue');
  const summary = { processed: 0, sent: 0, opened: 0, failed: 0, rateLimited: 0 };
  debugTrace('ProcessQueueStart', { traceId, parentTraceId: parentTraceId ?? 'none' });

  try {
    debugTrace('ClaimPendingQueueInvokeBefore', { traceId });
    const claimed = claimPendingQueue(traceId);
    debugTrace('ClaimPendingQueueInvokeAfter', { traceId, claimedCount: claimed.length });

    if (claimed.length === 0) {
      debugTraceDuration('ProcessQueueExit', startTime, { traceId, exitReason: 'empty_queue', ...summary });
      return summary;
    }

    debugTrace('LoadBulkDataBefore', { traceId });
    const contacts        = getAllContacts();
    const templates       = getAllTemplates();
    const customPlatforms = getAllPlatforms();
    const allPlatforms    = [...FIXED_PLATFORMS, ...customPlatforms];
    debugTrace('LoadBulkDataAfter', {
      traceId,
      contactCount: contacts.length,
      templateCount: templates.length,
      platformCount: allPlatforms.length,
    });

    const contactMap  = new Map(contacts.map((c) => [c.id, c]));
    const templateMap = new Map(templates.map((t) => [t.id, t]));
    const platformMap = new Map(allPlatforms.map((p) => [p.id, p]));

    let smsPermissionGranted = false;
    if (Platform.OS === 'android') {
      smsPermissionGranted = await requestSmsPermission();
    }
    debugTrace('HasWhatsAppCredentialsBefore', { traceId });
    const waConfigured = await hasWhatsAppCredentials();
    debugTrace('HasWhatsAppCredentialsAfter', { traceId, waConfigured });

    const smsPerHourLimit = getSmsPerHourLimit();
    let smsSentThisHour   = countSmsSentInLastHour();

    debugTrace('SmsRateLimitState', { traceId, smsSentThisHour, smsPerHourLimit });

    for (let i = 0; i < claimed.length; i++) {
      const item = claimed[i];
      const traceContext = {
        traceId,
        queueId: item.id,
        contactId: item.contact_id,
        templateId: item.template_id,
        platformId: item.platform_id,
        queueStatus: item.status,
        itemIndex: i,
        itemTotal: claimed.length,
      };

      const itemStartTime = Date.now();
      debugTrace('ProcessQueueItemStart', traceContext);

      const contact  = contactMap.get(item.contact_id);
      const template = templateMap.get(item.template_id);
      const platform = platformMap.get(item.platform_id);

      debugTrace('PlatformSelection', {
        ...traceContext,
        contactFound: !!contact,
        templateFound: !!template,
        platformFound: !!platform,
        selectedPlatformId: platform?.id ?? '',
      });

      if (platform?.id === 'sms' && smsSentThisHour >= smsPerHourLimit) {
        debugTrace('ProcessQueueItemRateLimited', {
          ...traceContext, exitReason: 'sms_hourly_limit_reached', smsSentThisHour, smsPerHourLimit,
        });
        revertToPending(item.id, traceId);
        summary.rateLimited += 1;
        debugTrace('ProcessQueueItemContinue', { ...traceContext, action: 'continue_rate_limited' });
        continue;
      }

      summary.processed += 1;

      if (!contact || !template || !platform) {
        const reason = [
          !contact  && 'CONTACT_NOT_FOUND',
          !template && 'TEMPLATE_NOT_FOUND',
          !platform && 'PLATFORM_NOT_FOUND',
        ].filter(Boolean).join('_AND_');
        debugTrace('ProcessQueueItemValidationFailed', { ...traceContext, exitReason: reason });
        markAsFailed(item.id, reason, traceId);
        summary.failed += 1;
        onProgress?.(summary.processed, claimed.length);
        debugTrace('ProcessQueueItemContinue', { ...traceContext, action: 'continue_validation_failed' });
        continue;
      }

      const needsEmail =
        platform.id === 'email' || platform.id === 'gmail' ||
        (platform.url_scheme ?? '').includes('{email}');
      if (needsEmail && !contact.email) {
        debugTrace('ProcessQueueItemValidationFailed', { ...traceContext, exitReason: 'email_missing_on_contact' });
        markAsFailed(item.id, 'EMAIL_MISSING_ON_CONTACT', traceId);
        summary.failed += 1;
        onProgress?.(summary.processed, claimed.length);
        debugTrace('ProcessQueueItemContinue', { ...traceContext, action: 'continue_email_missing' });
        continue;
      }

      const needsPhone =
        platform.id === 'sms' || platform.id === 'whatsapp' ||
        (platform.url_scheme ?? '').includes('{phone}');
      if (needsPhone && !contact.phone_number) {
        debugTrace('ProcessQueueItemValidationFailed', { ...traceContext, exitReason: 'phone_missing_on_contact' });
        markAsFailed(item.id, 'PHONE_MISSING_ON_CONTACT', traceId);
        summary.failed += 1;
        onProgress?.(summary.processed, claimed.length);
        debugTrace('ProcessQueueItemContinue', { ...traceContext, action: 'continue_phone_missing' });
        continue;
      }

      let isSmsAttempt = false;

      try {
        const daysLeft = getDaysUntilExpiry(contact.expiry_datetime);
        const message  = personalizeMessage(template.body, contact, daysLeft);
        debugTrace('MessagePersonalized', { ...traceContext, daysLeft, messageLength: message?.length ?? 0 });

        isSmsAttempt = platform.id === 'sms';

        debugTrace('DispatchItemBefore', { ...traceContext, platformId: platform.id });
        const result = await dispatchItem(
          platform, contact, message, smsPermissionGranted, waConfigured, traceContext,
        );
        debugTrace('DispatchItemAfter', { ...traceContext, result });

        if (result === 'sent') {
          markAsSent(item.id, traceId);
          summary.sent += 1;
          if (isSmsAttempt) smsSentThisHour += 1;
          debugTrace('ProcessQueueItemOutcome', { ...traceContext, outcome: 'sent' });
        } else if (result === 'opened') {
          markAsSent(item.id, traceId);
          summary.opened += 1;
          debugTrace('ProcessQueueItemOutcome', { ...traceContext, outcome: 'opened' });
        } else {
          const failReason = result.replace('failed_', '').toUpperCase();
          markAsFailed(item.id, failReason, traceId);
          summary.failed += 1;
          debugTrace('ProcessQueueItemOutcome', { ...traceContext, outcome: 'failed', failReason });
        }
      } catch (error) {
        debugTraceError('ProcessQueueItemCatch', error, { function: `processQueue.item.${item.id}`, ...traceContext });
        handleError(error, `processQueue.item.${item.id}`);
        markAsFailed(item.id, 'SEND_FAILED_UNKNOWN', traceId);
        summary.failed += 1;
        debugTrace('ProcessQueueItemOutcome', { ...traceContext, outcome: 'failed', failReason: 'SEND_FAILED_UNKNOWN' });
      }

      onProgress?.(summary.processed, claimed.length);
      debugTraceDuration('ProcessQueueItemEnd', itemStartTime, { ...traceContext, ...summary });

      if (i < claimed.length - 1) {
        const delayMs = isSmsAttempt ? SMS_INTRA_SEND_DELAY_MS : 1500;
        debugTrace('ProcessQueueInterItemDelayBefore', { ...traceContext, delayMs });
        await delay(delayMs);
        debugTrace('ProcessQueueInterItemDelayAfter', { ...traceContext, delayMs });
      }
    }

    if (summary.rateLimited > 0) {
      debugTrace('ProcessQueueRateLimitedSummary', {
        traceId, rateLimitedCount: summary.rateLimited, exitReason: 'sms_deferred_for_next_run',
      });
    }

    debugTraceDuration('ProcessQueueEnd', startTime, { traceId, outcome: 'completed', ...summary });
    return summary;
  } catch (error) {
    debugTraceError('ProcessQueueCatch', error, { function: 'processQueue', traceId });
    handleError(error, 'processQueue');
    debugTraceDuration('ProcessQueueEnd', startTime, { traceId, outcome: 'error', ...summary });
    return summary;
  }
};