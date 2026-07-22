import { getDB } from './db';
import { handleError } from '../utils/errorHandler';
import { debugTrace, debugTraceDbWrite, debugTraceError, debugTraceDuration } from '../utils/debugTrace';

export const QUEUE_STATUS = {
  PENDING: 'PENDING',
  CLAIMED: 'CLAIMED',
  SENT: 'SENT',
  FAILED: 'FAILED',
  SUPERSEDED: 'SUPERSEDED',
};

const getCurrentUtcISO = () => {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
};

/**
 * EXPORTED: Read-only getter used by other modules (alarmFireCore.js,
 * queueProcessor.js) so they never need to import raw getDB() themselves.
 */
export const getQueueRowById = (id) => {
  const db = getDB();
  const result = db.execute('SELECT * FROM message_queue WHERE id = ?;', [id]);
  return result.rows?._array?.[0] ?? null;
};

const countPriorSends = (db, contactId, templateId) => {
  const result = db.execute(
    `SELECT COUNT(*) as count FROM message_queue
     WHERE contact_id = ? AND template_id = ? AND status = 'SENT';`,
    [contactId, templateId],
  );
  return result.rows?._array?.[0]?.count ?? 0;
};

export const addToQueueDetailed = (contactId, templateId, platformId, scheduledForISO = null, traceId = null) => {
  const startTime = Date.now();
  debugTrace('AddToQueueDetailedStart', { traceId, contactId, templateId, platformId });
  try {
    const db = getDB();
    const alreadySentCount = countPriorSends(db, contactId, templateId);
    const id = `${contactId}_${templateId}_${Date.now()}`;
    const createdAtISO = getCurrentUtcISO();
    const scheduleTime = scheduledForISO || createdAtISO;
    
    debugTraceDbWrite('AddToQueueInsert', {
      table: 'message_queue', pk: id, oldState: 'none', newState: QUEUE_STATUS.PENDING,
      traceId, contactId, templateId, platformId, alreadySentCount,
    });

    try {
      db.execute(
        `INSERT INTO message_queue (id, contact_id, template_id, platform_id, status, scheduled_for, created_at)
         VALUES (?, ?, ?, ?, 'PENDING', ?, ?);`,
        [id, contactId, templateId, platformId, scheduleTime, createdAtISO],
      );

      debugTraceDuration('AddToQueueDetailedExit', startTime, {
        traceId, contactId, templateId, platformId, queueId: id, exitReason: 'queued', added: true, reason: 'QUEUED',
      });
      return { added: true, reason: 'QUEUED', queueId: id };

    } catch (insertError) {
      if (insertError.message && insertError.message.includes('UNIQUE constraint failed')) {
        debugTrace('AddToQueueDuplicateCheckResult', { traceId, contactId, templateId, duplicateCheckResult: 'ALREADY_ACTIVE' });
        debugTraceDuration('AddToQueueDetailedExit', startTime, {
          traceId, contactId, templateId, platformId, exitReason: 'already_active', added: false, reason: 'ALREADY_ACTIVE',
        });
        return { added: false, reason: 'ALREADY_ACTIVE' };
      }
      throw insertError;
    }
  } catch (error) {
    debugTraceError('AddToQueueDetailedCatch', error, { traceId, function: 'addToQueueDetailed', contactId, templateId, platformId });
    handleError(error, 'addToQueueDetailed');
    debugTraceDuration('AddToQueueDetailedExit', startTime, { traceId, contactId, templateId, platformId, exitReason: 'db_error', added: false, reason: 'DB_ERROR' });
    return { added: false, reason: 'DB_ERROR' };
  }
};

export const addToQueue = (contactId, templateId, platformId, scheduledForISO = null, traceId = null) => {
  return addToQueueDetailed(contactId, templateId, platformId, scheduledForISO, traceId).added;
};

export const claimPendingQueue = (callerId = null, limit = 50) => {
  const startTime = Date.now();
  debugTrace('ClaimPendingQueueStart', { callerId });
  try {
    const db = getDB();

    const dueRows = db.execute(
      `SELECT id FROM message_queue 
       WHERE status = 'PENDING' AND scheduled_for <= datetime('now') 
       ORDER BY scheduled_for ASC LIMIT ?;`,
      [limit],
    ).rows?._array ?? [];

    if (dueRows.length === 0) {
      debugTraceDuration('ClaimPendingQueueEnd', startTime, { callerId, claimedCount: 0, queueIds: '' });
      return [];
    }

    const ids = dueRows.map((r) => r.id);
    const placeholders = ids.map(() => '?').join(',');
    
    const claimToken = `${callerId ?? 'unknown'}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    debugTraceDbWrite('ClaimPendingQueueUpdate', {
      table: 'message_queue', pk: ids.join(','), oldState: QUEUE_STATUS.PENDING, newState: QUEUE_STATUS.CLAIMED,
      rowCount: ids.length, claimedBy: callerId, claimToken,
    });

    db.execute(
      `UPDATE message_queue 
       SET status = 'CLAIMED', claimed_by = ?
       WHERE id IN (${placeholders}) AND status = 'PENDING';`,
      [claimToken, ...ids],
    );

    const result = db.execute(
      `SELECT * FROM message_queue WHERE claimed_by = ? AND status = 'CLAIMED' ORDER BY scheduled_for ASC;`,
      [claimToken],
    );
    
    const claimed = result.rows?._array || [];
    debugTraceDuration('ClaimPendingQueueEnd', startTime, {
      callerId, claimedCount: claimed.length, queueIds: claimed.map((r) => r.id).join(','),
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
    const result = db.execute(`SELECT * FROM message_queue WHERE status = 'PENDING' ORDER BY scheduled_for ASC;`);
    return result.rows?._array || [];
  } catch (error) {
    handleError(error, 'getPendingQueue');
    return [];
  }
};

export const getAllQueue = () => {
  try {
    const db = getDB();
    const result = db.execute(`SELECT * FROM message_queue ORDER BY created_at DESC;`);
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
    const row = getQueueRowById(id);
    const alreadySentCount = row ? countPriorSends(db, row.contact_id, row.template_id) : 0;
    const sentAtISO = getCurrentUtcISO();
    
    debugTraceDbWrite('MarkAsSentUpdate', {
      table: 'message_queue', pk: id, oldState: row?.status ?? 'unknown', newState: QUEUE_STATUS.SENT,
      traceId, contactId: row?.contact_id ?? '', templateId: row?.template_id ?? '', alreadySentCount,
    });
    
    db.execute(
      `UPDATE message_queue SET status = 'SENT', sent_at = ?, error_reason = NULL WHERE id = ?;`,
      [sentAtISO, id],
    );
    
    debugTrace('MarkAsSentEnd', { traceId, queueId: id, contactId: row?.contact_id ?? '', templateId: row?.template_id ?? '', status: QUEUE_STATUS.SENT });
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
    const row = getQueueRowById(id);
    
    debugTraceDbWrite('MarkAsFailedUpdate', {
      table: 'message_queue', pk: id, oldState: row?.status ?? 'unknown', newState: QUEUE_STATUS.FAILED,
      traceId, contactId: row?.contact_id ?? '', templateId: row?.template_id ?? '', errorReason: reason,
    });
    
    db.execute(
      `UPDATE message_queue SET status = 'FAILED', error_reason = ?, attempt_count = attempt_count + 1 WHERE id = ?;`,
      [reason, id],
    );
    
    debugTrace('MarkAsFailedEnd', { traceId, queueId: id, contactId: row?.contact_id ?? '', templateId: row?.template_id ?? '', status: QUEUE_STATUS.FAILED, errorReason: reason });
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
    const row = getQueueRowById(id);
    
    debugTraceDbWrite('RevertToPendingUpdate', {
      table: 'message_queue', pk: id, oldState: row?.status ?? 'unknown', newState: QUEUE_STATUS.PENDING,
      traceId, contactId: row?.contact_id ?? '', templateId: row?.template_id ?? '', reason: 'rate_limited_or_retry',
    });
    
    db.execute(`UPDATE message_queue SET status = 'PENDING', claimed_by = NULL WHERE id = ?;`, [id]);
    
    debugTrace('RevertToPendingEnd', { traceId, queueId: id, contactId: row?.contact_id ?? '', templateId: row?.template_id ?? '', status: QUEUE_STATUS.PENDING });
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