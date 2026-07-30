/**
 * Shared ID and token generators used by message_queue and scheduled_alarms.
 * Extracted from inline duplication in messageQueueDB.js and scheduledAlarmDB.js
 * to ensure ID/claim-token format stays consistent across all call sites.
 */

/**
 * Generate a unique queue item ID.
 * Pattern: {contactId}_{templateId}_{unixMs}_{5charRandom}
 * The random suffix prevents same-millisecond collision between two calls.
 */
export const generateQueueId = (contactId, templateId) => {
  return `${contactId}_${templateId}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
};

/**
 * Generate a unique claim token for distributed locking.
 * Pattern: {callerId}-{unixMs}-{6charRandom}
 */
export const generateClaimToken = (callerId = null) => {
  return `${callerId ?? 'unknown'}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
};
