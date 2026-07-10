import { Platform } from 'react-native';
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
import { debugTrace, debugTraceError, debugTraceDuration, generateTraceId } from './debugTrace';
import { getAdapter } from '../platforms/registry';
import { requestSmsPermission } from '../platforms/localTextAdapter'; // also self-registers 'local_text'
import { isConfigured as hasWhatsAppCredentials } from '../platforms/whatsappAdapter'; // also self-registers 'managed_remote'

export const FIXED_PLATFORMS = [
  { id: 'sms',      name: 'SMS',      url_scheme: 'sms:{phone}?body={message}', platform_type: 'local_text' },
  { id: 'whatsapp', name: 'WhatsApp', url_scheme: '', platform_type: 'managed_remote' },
  { id: 'email',    name: 'Email',    url_scheme: 'mailto:{email}?subject={subject}&body={message}', platform_type: 'local_text' },
  { id: 'gmail',    name: 'Gmail',    url_scheme: 'googlegmail://co?to={email}&subject={subject}&body={message}', platform_type: 'local_text' },
];

const SMS_INTRA_SEND_DELAY_MS = 3500;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Registry-routed dispatch — looks up the adapter by platform_type and hands
// off. Both adapters accept the same combined ctx and pick what they need
// (local_text reads smsPermissionGranted, managed_remote reads waConfigured),
// so this function stays platform-agnostic. Result vocabulary unchanged:
// 'sent' | 'opened' | 'failed_<REASON>'.
const dispatchItem = async (platform, contact, message, smsPermissionGranted, waConfigured, traceContext = {}) => {
  debugTrace('DispatchItemStart', {
    ...traceContext,
    platformId: platform.id,
    contactId: contact.id,
    smsPermissionGranted,
    waConfigured,
  });

  const adapter = getAdapter(platform.platform_type ?? 'local_text');
  return adapter.dispatch(platform, contact, message, { smsPermissionGranted, waConfigured, traceContext });
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