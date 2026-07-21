import { getDB } from './db';
import { handleError } from '../utils/errorHandler';
import { debugTrace, debugTraceDbWrite, debugTraceError, debugTraceDuration } from '../utils/debugTrace';

export const QUEUE_STATUS = {
  PENDING: 'PENDING',
  PROCESSING: 'PROCESSING',
  SENT: 'SENT',
  FAILED: 'FAILED',
};

// Helper to get current UTC ISO timestamp (with 'Z' suffix)
const getCurrentUtcISO = () => {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
};

const getQueueRowById = (db, id) => {
  const result = db.execute('SELECT * FROM message_queue WHERE id = ?;', [id]);
  return result.rows?._array?.[0] ?? null;
};

/**
 * Counts how many times this exact contact+template pair has ever been
 * SENT — used purely for duplicate-detection observability (Point 7).
 * Does not affect dedupe logic itself (that's still the 30-day window
 * check below); this is extra context in the trace log so you can see,
 * e.g., "this is the 3rd time this pair was sent" even if each individual
 * send was legitimately allowed (different expiry cycles).
 */
const countPriorSends = (db, contactId, templateId) => {
  const result = db.execute(
    `SELECT COUNT(*) as count FROM message_queue
     WHERE contact_id = ? AND template_id = ? AND status = 'SENT';`,
    [contactId, templateId],
  );
  return result.rows?._array?.[0]?.count ?? 0;
};

export const addToQueueDetailed = (contactId, templateId, platformId, traceId = null) => {
  const startTime = Date.now();
  debugTrace('AddToQueueDetailedStart', { traceId, contactId, templateId, platformId });
  try {
    const db = getDB();

    const alreadySentCount = countPriorSends(db, contactId, templateId);

    debugTrace('AddToQueuePendingCheckBefore', { traceId, contactId, templateId, platformId });
    const pendingCheck = db.execute(
      `SELECT id FROM message_queue
       WHERE contact_id = ? AND template_id = ? AND status IN ('PENDING', 'PROCESSING');`,
      [contactId, templateId],
    );
    if (pendingCheck.rows?._array?.length > 0) {
      const existingId = pendingCheck.rows._array[0].id;
      debugTrace('AddToQueueDuplicateCheckResult', {
        traceId,
        contactId,
        templateId,
        queueId: existingId,
        alreadySentCount,
        duplicateCheckResult: 'ALREADY_PENDING',
      });
      debugTraceDuration('AddToQueueDetailedExit', startTime, {
        traceId,
        contactId,
        templateId,
        platformId,
        queueId: existingId,
        exitReason: 'already_pending',
        added: false,
        reason: 'ALREADY_PENDING',
      });
      return { added: false, reason: 'ALREADY_PENDING' };
    }

    debugTrace('AddToQueueSentCheckBefore', { traceId, contactId, templateId, platformId });
    const sentCheck = db.execute(
      `SELECT id FROM message_queue
       WHERE contact_id = ? AND template_id = ? AND status = 'SENT'
       AND datetime(sent_at) >= datetime('now', '-30 days');`,
      [contactId, templateId],
    );
    if (sentCheck.rows?._array?.length > 0) {
      const existingId = sentCheck.rows._array[0].id;
      debugTrace('AddToQueueDuplicateCheckResult', {
        traceId,
        contactId,
        templateId,
        queueId: existingId,
        alreadySentCount,
        duplicateCheckResult: 'ALREADY_SENT_RECENTLY',
      });
      debugTraceDuration('AddToQueueDetailedExit', startTime, {
        traceId,
        contactId,
        templateId,
        platformId,
        queueId: existingId,
        exitReason: 'already_sent_recently',
        added: false,
        reason: 'ALREADY_SENT_RECENTLY',
      });
      return { added: false, reason: 'ALREADY_SENT_RECENTLY' };
    }

    const recentFailCheck = db.execute(
      `SELECT id FROM message_queue
       WHERE contact_id = ? AND template_id = ? AND status = 'FAILED'
       AND datetime(created_at) >= datetime('now', '-24 hours');`,
      [contactId, templateId],
    );
    if (recentFailCheck.rows?._array?.length > 0) {
      const existingId = recentFailCheck.rows._array[0].id;
      debugTrace('AddToQueueDuplicateCheckResult', {
        traceId,
        contactId,
        templateId,
        queueId: existingId,
        alreadySentCount,
        duplicateCheckResult: 'RECENTLY_FAILED',
      });
      debugTraceDuration('AddToQueueDetailedExit', startTime, {
        traceId,
        contactId,
        templateId,
        platformId,
        queueId: existingId,
        exitReason: 'recently_failed',
        added: false,
        reason: 'RECENTLY_FAILED',
      });
      return { added: false, reason: 'RECENTLY_FAILED' };
    }

    const id = `${contactId}_${templateId}_${Date.now()}`;
    const createdAtISO = getCurrentUtcISO(); // Use proper UTC ISO format
    
    debugTraceDbWrite('AddToQueueInsert', {
      table: 'message_queue',
      pk: id,
      oldState: 'none',
      newState: QUEUE_STATUS.PENDING,
      traceId,
      contactId,
      templateId,
      platformId,
      alreadySentCount,
    });

    db.execute(
      `INSERT INTO message_queue (id, contact_id, template_id, platform_id, status, created_at)
       VALUES (?, ?, ?, ?, 'PENDING', ?);`,
      [id, contactId, templateId, platformId, createdAtISO],
    );

    debugTraceDuration('AddToQueueDetailedExit', startTime, {
      traceId,
      contactId,
      templateId,
      platformId,
      queueId: id,
      exitReason: 'queued',
      added: true,
      reason: 'QUEUED',
    });

    return { added: true, reason: 'QUEUED' };
  } catch (error) {
    debugTraceError('AddToQueueDetailedCatch', error, {
      traceId,
      function: 'addToQueueDetailed',
      contactId,
      templateId,
      platformId,
    });

    handleError(error, 'addToQueueDetailed');

    debugTraceDuration('AddToQueueDetailedExit', startTime, {
      traceId,
      contactId,
      templateId,
      platformId,
      exitReason: 'db_error',
      added: false,
      reason: 'DB_ERROR',
    });

    return { added: false, reason: 'DB_ERROR' };
  }
};

export const addToQueue = (contactId, templateId, platformId, traceId = null) => {
  return addToQueueDetailed(contactId, templateId, platformId, traceId).added;
};

/**
 * @param {string} callerId  Identifies WHICH execution is claiming the
 *                            queue — e.g. a traceId from processQueue()'s
 *                            caller. Logged as claimedBy so that if two
 *                            processQueue() runs happen close together,
 *                            the logs show unambiguously which run's
 *                            claim actually grabbed which rows (Point 6 —
 *                            queue ownership).
 */
export const claimPendingQueue = (callerId = null) => {
  const startTime = Date.now();
  debugTrace('ClaimPendingQueueStart', { callerId });
  try {
    const db = getDB();

    // ---------------------------------------------------------------------
    // Recover stale PROCESSING rows left behind by a run that never
    // finished (headless task killed mid-send, app force-closed, etc).
    // We do NOT silently resend these — for SMS the native send may have
    // already gone out before the crash — so they're moved to FAILED and
    // surfaced in the Failed tab for a deliberate manual retry instead.
    // This is what previously caused "reopening the app resends messages
    // that were already sent" and the endless SMS retry behavior: the old
    // query below picked up ALL status='PROCESSING' rows, including these
    // stuck ones, every single run.
    // ---------------------------------------------------------------------
    const STALE_PROCESSING_MINUTES = 2;
    const staleRows = db.execute(
      `SELECT id, contact_id, template_id FROM message_queue
       WHERE status = 'PROCESSING'
       AND datetime(created_at) <= datetime('now', '-${STALE_PROCESSING_MINUTES} minutes');`,
    ).rows?._array ?? [];

    if (staleRows.length > 0) {
        debugTrace('ClaimPendingQueueStaleProcessingFound', {
        callerId,
        staleCount: staleRows.length,
        staleIds: staleRows.map((r) => r.id).join(','),
      });
      staleRows.forEach((row) => {
        debugTraceDbWrite('ClaimPendingQueueStaleProcessingRecovered', {
          table: 'message_queue',
          pk: row.id,
          oldState: 'PROCESSING',
          newState: 'FAILED',
          callerId,
          contactId: row.contact_id,
          templateId: row.template_id,
          reason: 'STUCK_PROCESSING_TIMEOUT',
        });
      });
      db.execute(
        `UPDATE message_queue
         SET status = 'FAILED', error_reason = 'STUCK_PROCESSING_TIMEOUT', attempt_count = attempt_count + 1
         WHERE status = 'PROCESSING' AND datetime(created_at) <= datetime('now', '-${STALE_PROCESSING_MINUTES} minutes');`,
      );
    }

    const pendingBefore = db.execute(
      `SELECT id, contact_id, template_id, status FROM message_queue WHERE status = 'PENDING';`,
    ).rows?._array ?? [];
    debugTrace('ClaimPendingQueueBeforeUpdate', {
      callerId,
      pendingCount: pendingBefore.length,
      pendingIds: pendingBefore.map((r) => r.id).join(','),
    });

    if (pendingBefore.length === 0) {
      debugTraceDuration('ClaimPendingQueueEnd', startTime, { callerId, claimedCount: 0, queueIds: '' });
      return [];
    }

    const ids = pendingBefore.map((r) => r.id);
    const placeholders = ids.map(() => '?').join(',');

    // Unique per call — guarantees this claim can only ever pick up rows
    // this exact call itself flipped, even if another concurrent claim
    // (native alarm vs safety-net worker, different JS contexts) runs its
    // own SELECT-UPDATE-SELECT sequence interleaved with this one.
    const claimToken = `${callerId ?? 'unknown'}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    debugTraceDbWrite('ClaimPendingQueueUpdate', {
      table: 'message_queue',
      pk: ids.join(','),
      oldState: QUEUE_STATUS.PENDING,
      newState: QUEUE_STATUS.PROCESSING,
      rowCount: ids.length,
      claimedBy: callerId,
      claimToken,
    });
    // Critical: status = 'PENDING' is re-checked HERE, at write time — not
    // just at the read above. If another claim already flipped one of
    // these ids away from PENDING between our SELECT and this UPDATE, this
    // WHERE clause skips it, so we can never steal a row someone else
    // already has.
    db.execute(
      `UPDATE message_queue SET status = 'PROCESSING', claimed_by = ?
       WHERE id IN (${placeholders}) AND status = 'PENDING';`,
      [claimToken, ...ids],
    );

    // Only return rows THIS call's claim token actually landed on — never
    // "everything currently PROCESSING", which could include another
    // run's in-flight rows.
    const result = db.execute(
      `SELECT * FROM message_queue WHERE claimed_by = ? AND status = 'PROCESSING' ORDER BY created_at ASC;`,
      [claimToken],
    );
    const claimed = result.rows?._array || [];
    debugTraceDuration('ClaimPendingQueueEnd', startTime, {
      callerId,
      claimedCount: claimed.length,
      queueIds: claimed.map((r) => r.id).join(','),
    });
    return claimed;
  } catch (error) {
    debugTraceError('ClaimPendingQueueCatch', error, { function: 'claimPendingQueue', callerId });
    handleError(error, 'claimPendingQueue');
    debugTrace('ClaimPendingQueueExit', { callerId, exitReason: 'db_error', claimedCount: 0 });
    return [];
  }
};

export const getPendingQueue = () => {
  try {
    const db = getDB();
    const result = db.execute(
      `SELECT * FROM message_queue WHERE status = 'PENDING' ORDER BY created_at ASC;`,
    );
    return result.rows?._array || [];
  } catch (error) {
    handleError(error, 'getPendingQueue');
    return [];
  }
};

export const getAllQueue = () => {
  try {
    const db = getDB();
    const result = db.execute(
      `SELECT * FROM message_queue ORDER BY created_at DESC;`,
    );
    return result.rows?._array || [];
  } catch (error) {
    handleError(error, 'getAllQueue');
    return [];
  }
};

export const markAsSent = (id, traceId = null) => {
  debugTrace('MarkAsSentStart', { traceId, queueId: id });
  try {
    const db = getDB();
    const row = getQueueRowById(db, id);
    const alreadySentCount = row ? countPriorSends(db, row.contact_id, row.template_id) : 0;
    const sentAtISO = getCurrentUtcISO(); // Use proper UTC ISO format
    
    debugTraceDbWrite('MarkAsSentUpdate', {
      table: 'message_queue',
      pk: id,
      oldState: row?.status ?? 'unknown',
      newState: QUEUE_STATUS.SENT,
      traceId,
      contactId: row?.contact_id ?? '',
      templateId: row?.template_id ?? '',
      alreadySentCount,
    });
    db.execute(
      `UPDATE message_queue SET status = 'SENT', sent_at = ?, error_reason = NULL WHERE id = ?;`,
      [sentAtISO, id],
    );
    debugTrace('MarkAsSentEnd', {
      traceId,
      queueId: id,
      contactId: row?.contact_id ?? '',
      templateId: row?.template_id ?? '',
      status: QUEUE_STATUS.SENT,
    });
    return true;
  } catch (error) {
    debugTraceError('MarkAsSentCatch', error, { function: 'markAsSent', traceId, queueId: id });
    handleError(error, 'markAsSent');
    return false;
  }
};

export const markAsFailed = (id, reason, traceId = null) => {
  debugTrace('MarkAsFailedStart', { traceId, queueId: id, errorReason: reason });
  try {
    const db = getDB();
    const row = getQueueRowById(db, id);
    debugTraceDbWrite('MarkAsFailedUpdate', {
      table: 'message_queue',
      pk: id,
      oldState: row?.status ?? 'unknown',
      newState: QUEUE_STATUS.FAILED,
      traceId,
      contactId: row?.contact_id ?? '',
      templateId: row?.template_id ?? '',
      errorReason: reason,
    });
    db.execute(
      `UPDATE message_queue SET status = 'FAILED', error_reason = ?, attempt_count = attempt_count + 1 WHERE id = ?;`,
      [reason, id],
    );
    debugTrace('MarkAsFailedEnd', {
      traceId,
      queueId: id,
      contactId: row?.contact_id ?? '',
      templateId: row?.template_id ?? '',
      status: QUEUE_STATUS.FAILED,
      errorReason: reason,
    });
    return true;
  } catch (error) {
    debugTraceError('MarkAsFailedCatch', error, { function: 'markAsFailed', traceId, queueId: id, errorReason: reason });
    handleError(error, 'markAsFailed');
    return false;
  }
};

export const removeFromQueue = (id) => {
  try {
    const db = getDB();
    db.execute(`DELETE FROM message_queue WHERE id = ?;`, [id]);
    return true;
  } catch (error) {
    handleError(error, 'removeFromQueue');
    return false;
  }
};

export const revertToPending = (id, traceId = null) => {
  debugTrace('RevertToPendingStart', { traceId, queueId: id });
  try {
    const db = getDB();
    const row = getQueueRowById(db, id);
    debugTraceDbWrite('RevertToPendingUpdate', {
      table: 'message_queue',
      pk: id,
      oldState: row?.status ?? 'unknown',
      newState: QUEUE_STATUS.PENDING,
      traceId,
      contactId: row?.contact_id ?? '',
      templateId: row?.template_id ?? '',
      reason: 'sms_rate_limited',
    });
    db.execute(`UPDATE message_queue SET status = 'PENDING' WHERE id = ?;`, [id]);
    debugTrace('RevertToPendingEnd', {
      traceId,
      queueId: id,
      contactId: row?.contact_id ?? '',
      templateId: row?.template_id ?? '',
      status: QUEUE_STATUS.PENDING,
    });
    return true;
  } catch (error) {
    debugTraceError('RevertToPendingCatch', error, { function: 'revertToPending', traceId, queueId: id });
    handleError(error, 'revertToPending');
    return false;
  }
};

export const countSmsSentInLastHour = () => {
  try {
    const db = getDB();
    const result = db.execute(
      `SELECT COUNT(*) as count FROM message_queue
       WHERE platform_id = 'sms' AND status = 'SENT'
       AND datetime(sent_at) >= datetime('now', '-60 minutes');`,
    );
    return result.rows?._array?.[0]?.count ?? 0;
  } catch (error) {
    handleError(error, 'countSmsSentInLastHour');
    return 0;
  }
};
