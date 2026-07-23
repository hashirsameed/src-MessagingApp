import { Platform, NativeModules } from 'react-native';
import {
  claimPendingQueue, markAsSent, markAsFailed, revertToPending, getQueueRowById,
} from '../database/messageQueueDB';
import { getAllContacts } from '../database/contactDB';
import { getAllTemplates } from '../database/templateDB';
import { getAllPlatforms } from '../database/platformDB';
import { getRateLimit, countSentInWindow } from '../database/rateLimitDB';
import { getDaysUntilExpiry, personalizeMessage } from './templateMatcher';
import { handleError } from './errorHandler';
import { debugTrace, debugTraceError, debugTraceDuration, generateTraceId } from './debugTrace';
import { getAdapter } from '../platforms/registry';
import { requestSmsPermission } from '../platforms/localTextAdapter';
import { isConfigured as hasWhatsAppCredentials } from '../platforms/whatsappAdapter';

const { AlarmModule } = NativeModules;

// ─────────────────────────────────────────────────────────────────────────────
// FIX 1 — processQueue concurrency lock
// Masla: runExpiryCheck, AlarmFiredTask, aur SafetyNetTask teeno ek waqt mein
//         processQueue() call kar sakte hain. Concurrent calls ki apni alag
//         sentInWindow Map hoti hai, isliye rate limit galat count hoti thi.
// Fix:   Module-level _isProcessing flag. Doosri call foran return karti hai.
// ─────────────────────────────────────────────────────────────────────────────
let _isProcessing = false;

const refreshReminderSurfacesIfChanged = (summary) => {
  if (Platform.OS !== 'android') return;
  if (!AlarmModule?.refreshReminderSurfaces) return;
  if (summary.sent === 0 && summary.opened === 0 && summary.failed === 0) return;
  AlarmModule.refreshReminderSurfaces().catch((error) => {
    handleError(error, 'processQueue.refreshReminderSurfaces');
  });
};

export const FIXED_PLATFORMS = [
  { id: 'sms',      name: 'SMS',      url_scheme: 'sms:{phone}?body={message}', platform_type: 'local_text' },
  { id: 'whatsapp', name: 'WhatsApp', url_scheme: '', platform_type: 'managed_remote' },
  { id: 'email',    name: 'Email',    url_scheme: 'mailto:{email}?subject={subject}&body={message}', platform_type: 'local_text' },
  { id: 'gmail',    name: 'Gmail',    url_scheme: 'googlegmail://co?to={email}&subject={subject}&body={message}', platform_type: 'local_text' },
];

const SMS_INTRA_SEND_DELAY_MS = 3500;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const dispatchItem = async (platform, contact, message, smsPermissionGranted, waConfigured, traceContext = {}, template = null) => {
  debugTrace('DispatchItemStart', {
    ...traceContext,
    platformId: platform.id,
    contactId: contact.id,
    smsPermissionGranted,
    waConfigured,
  });

  const adapter = getAdapter(platform.platform_type ?? 'local_text');
  return adapter.dispatch(platform, contact, message, { smsPermissionGranted, waConfigured, traceContext, template });
};

export const processQueue = async (onProgress, parentTraceId = null) => {
  // FIX 1 — Concurrency guard: agar pehle se chal raha hai to foran return karo
  if (_isProcessing) {
    debugTrace('ProcessQueueSkipped', { reason: 'already_running', parentTraceId: parentTraceId ?? 'none' });
    return { processed: 0, sent: 0, opened: 0, failed: 0, rateLimited: 0 };
  }
  _isProcessing = true;

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

    const waConfigured = await hasWhatsAppCredentials();
    debugTrace('HasWhatsAppCredentialsAfter', { traceId, waConfigured });

    const rateLimits = new Map();
    const sentInWindow = new Map();

    const getPlatformRateLimit = (platformId) => {
      if (!rateLimits.has(platformId)) {
        rateLimits.set(platformId, getRateLimit(platformId));
      }
      return rateLimits.get(platformId);
    };
    const getSentInWindow = (platformId, windowMinutes) => {
      if (!sentInWindow.has(platformId)) {
        sentInWindow.set(platformId, countSentInWindow(platformId, windowMinutes));
      }
      return sentInWindow.get(platformId);
    };

    debugTrace('RateLimitState', { traceId, platforms: allPlatforms.map((p) => p.id).join(',') });

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

      // --- RATE LIMIT CHECK ---
      const rateLimit = platform ? getPlatformRateLimit(platform.id) : null;
      if (rateLimit) {
        const currentSent = getSentInWindow(platform.id, rateLimit.windowMinutes);
        if (currentSent >= rateLimit.limitCount) {
          debugTrace('ProcessQueueItemRateLimited', {
            ...traceContext, exitReason: 'platform_rate_limit_reached',
            platformId: platform.id, currentSent,
            limitCount: rateLimit.limitCount, windowMinutes: rateLimit.windowMinutes,
          });
          revertToPending(item.id, traceId);
          summary.rateLimited += 1;
          continue;
        }
      }

      summary.processed += 1;

      // --- VALIDATION CHECKS ---
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
        continue;
      }

      const needsEmail = platform.id === 'email' || platform.id === 'gmail' || (platform.url_scheme ?? '').includes('{email}');
      if (needsEmail && !contact.email) {
        debugTrace('ProcessQueueItemValidationFailed', { ...traceContext, exitReason: 'email_missing_on_contact' });
        markAsFailed(item.id, 'EMAIL_MISSING_ON_CONTACT', traceId);
        summary.failed += 1;
        onProgress?.(summary.processed, claimed.length);
        continue;
      }

      const needsPhone = platform.id === 'sms' || platform.id === 'whatsapp' || (platform.url_scheme ?? '').includes('{phone}');
      if (needsPhone && !contact.phone_number) {
        debugTrace('ProcessQueueItemValidationFailed', { ...traceContext, exitReason: 'phone_missing_on_contact' });
        markAsFailed(item.id, 'PHONE_MISSING_ON_CONTACT', traceId);
        summary.failed += 1;
        onProgress?.(summary.processed, claimed.length);
        continue;
      }

      // ========================================================================
      // 🚨 INDUSTRY-GRADE IN-FLIGHT GUARD RAIL
      // Location: inside loop, right before dispatch (after validations/delays).
      // Action: silent skip (continue). NO markAsFailed/markAsSent.
      // States: SUPERSEDED, CANCELLED, SENT, or DELETED (!freshRow).
      // ✅ FIXED: uses exported getQueueRowById() from messageQueueDB.js —
      // no raw getDB()/db.execute() here, preserving DB-layering convention.
      // ========================================================================
      const freshRow = getQueueRowById(item.id);

      if (!freshRow || freshRow.status === 'SUPERSEDED' || freshRow.status === 'CANCELLED' || freshRow.status === 'SENT') {
        debugTrace('ProcessQueueItemInFlightAbort', {
          ...traceContext,
          exitReason: 'in_flight_aborted_by_guard_rail',
          freshStatus: freshRow?.status ?? 'DELETED_VIA_CASCADE',
        });
        continue;
      }
      // ========================================================================

      let isSmsAttempt = false;

      try {
        const daysLeft = getDaysUntilExpiry(contact.expiry_datetime);
        const message  = personalizeMessage(template.body, contact, daysLeft);
        debugTrace('MessagePersonalized', { ...traceContext, daysLeft, messageLength: message?.length ?? 0 });

        isSmsAttempt = platform.id === 'sms';

        debugTrace('DispatchItemBefore', { ...traceContext, platformId: platform.id });
        const result = await dispatchItem(
          platform, contact, message, smsPermissionGranted, waConfigured, traceContext, template,
        );
        debugTrace('DispatchItemAfter', { ...traceContext, result });

        if (result === 'sent') {
          markAsSent(item.id, traceId);
          summary.sent += 1;
          if (rateLimit) {
            sentInWindow.set(platform.id, getSentInWindow(platform.id, rateLimit.windowMinutes) + 1);
          }
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
        traceId, rateLimitedCount: summary.rateLimited, exitReason: 'deferred_for_next_run',
      });
    }

    debugTraceDuration('ProcessQueueEnd', startTime, { traceId, outcome: 'completed', ...summary });
    refreshReminderSurfacesIfChanged(summary);
    return summary;
  } catch (error) {
    debugTraceError('ProcessQueueCatch', error, { function: 'processQueue', traceId });
    handleError(error, 'processQueue');
    debugTraceDuration('ProcessQueueEnd', startTime, { traceId, outcome: 'error', ...summary });
    refreshReminderSurfacesIfChanged(summary);
    return summary;
  } finally {
    // FIX 1 — Lock hamesha release karo, chahe error aaye ya na aaye
    _isProcessing = false;
  }
};