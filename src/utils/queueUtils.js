/**
 * queueUtils.js — Shared helpers extracted from queueProcessor.js
 * to eliminate duplication between processLane and processSingleItem.
 *
 * Every function here is deliberately synchronous and side-effect-free
 * where marked, so they compose cleanly into the two execution paths.
 */

import { countSentInWindow } from '../database/rateLimitDB';
import { getInFlightCount } from './rateLimitReservation';
import { markAsSent, markAsFailed, revertToPending } from '../database/messageQueueDB';
import { debugTrace } from './debugTrace';

// ─────────────────────────────────────────────────────────────────────────────
// 1. Rate-limit gate: count DB-sent + in-flight reservations vs configured cap.
//
// Returns { limited, currentSent } where `limited` tells the caller whether
// the platform's send budget is exhausted. The caller is responsible for
// reverting items and scheduling a retry alarm.
// ─────────────────────────────────────────────────────────────────────────────
export const isRateLimited = (platformId, rateLimit) => {
  if (!rateLimit) return { limited: false, currentSent: 0 };
  const dbSent = countSentInWindow(platformId, rateLimit.windowMinutes);
  const inFlight = getInFlightCount(platformId, rateLimit.windowMinutes);
  return {
    limited: dbSent + inFlight >= rateLimit.limitCount,
    currentSent: dbSent + inFlight,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// 2. Validate a queue item against its resolved contact/template/platform.
//
// Returns null when valid, or a failure reason string when invalid. The caller
// should markAsFailed with the returned reason.
// ─────────────────────────────────────────────────────────────────────────────
export const validateQueueItem = (item, contact, template, platform) => {
  if (!contact && !template && !platform) return 'CONTACT_AND_TEMPLATE_AND_PLATFORM_NOT_FOUND';
  if (!contact) return 'CONTACT_NOT_FOUND';
  if (!template) return 'TEMPLATE_NOT_FOUND';
  if (!platform) return 'PLATFORM_NOT_FOUND';

  // Email platforms require an email address on the contact
  const needsEmail =
    platform.id === 'email' || platform.id === 'gmail' ||
    (platform.url_scheme && platform.url_scheme.includes('{email}'));
  if (needsEmail && !contact.email) return 'EMAIL_MISSING_ON_CONTACT';

  // Phone-based platforms require a phone number on the contact
  const needsPhone =
    platform.id === 'sms' || platform.id === 'whatsapp' ||
    (platform.url_scheme && platform.url_scheme.includes('{phone}'));
  if (needsPhone && !contact.phone_number) return 'PHONE_MISSING_ON_CONTACT';

  return null; // valid
};

// ─────────────────────────────────────────────────────────────────────────────
// 3. Normalize adapter dispatch result.
//
// localTextAdapter returns a plain string ('sent' | 'failed_...').
// whatsappAdapter returns an object ({ status, retryAfterMs, ... }).
// This normalizes both to { status, ... } so the rest of the pipeline
// uses a single branching structure.
// ─────────────────────────────────────────────────────────────────────────────
export const normalizeDispatchResult = (raw) =>
  typeof raw === 'string' ? { status: raw } : raw;

// ─────────────────────────────────────────────────────────────────────────────
// 4. Handle a dispatch outcome atomically.
//
// Returns { sent, failed, wasRateLimited } so callers can accumulate in
// their summary counters. Never throws.
// ─────────────────────────────────────────────────────────────────────────────
export const handleDispatchOutcome = (queueId, outcome, traceId = null) => {
  debugTrace('HandleDispatchOutcome', { queueId, status: outcome.status, traceId });

  if (outcome.status === 'sent' || outcome.status === 'opened') {
    markAsSent(queueId, traceId);
    return { sent: 1, failed: 0, wasRateLimited: false };
  }

  if (outcome.status === 'rate_limited_WA') {
    revertToPending(queueId, traceId);
    return { sent: 0, failed: 0, wasRateLimited: true, retryAfterMs: outcome.retryAfterMs ?? null };
  }

  // Anything else is a permanent failure
  const reason = outcome.reason ?? outcome.status?.replace(/^failed_/, '') ?? 'SEND_FAILED_UNKNOWN';
  markAsFailed(queueId, reason, traceId);
  return { sent: 0, failed: 1, wasRateLimited: false };
};
