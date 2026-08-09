import { getDB } from './db';
import { handleError } from '../utils/errorHandler';
import { debugTrace, debugTraceDbWrite, debugTraceError, debugTraceDuration } from '../utils/debugTrace';
import { generateQueueId, generateClaimToken } from '../utils/idUtils';
import { toUTCISOString } from '../utils/dateFormat';

export const QUEUE_STATUS = {
  PENDING: 'PENDING',
  CLAIMED: 'CLAIMED',
  SENT: 'SENT',
  FAILED: 'FAILED',
  SUPERSEDED: 'SUPERSEDED',
};

const getCurrentUtcISO = () => toUTCISOString(new Date());

/**
 * EXPORTED: Read-only getter used by other modules (alarmFireCore.js,
 * queueProcessor.js) so they never need to import raw getDB() themselves.
 */
export const getQueueRowById = (id) => {
  const db = getDB();
  const result = db.execute('SELECT * FROM message_queue WHERE id = ?;', [id]);
  return result.rows?._array?.[0] ?? null;
};

// ─────────────────────────────────────────────────────────────────────────
// Cycle-aware "already sent" check.
// Masla: agar hum sirf contact_id+template_id ka lifetime SENT count lein,
//         to contact ka expiry renew hone ke baad (naya cycle shuru hone
//         par) wohi template kabhi dobara fire nahi hoga — jabke wo legitimate
//         resend hona chahiye.
// Fix:   Sirf un SENT rows ko count karo jo contact ke current cycle mein
//         bheje gaye hain — yani contact ke last update (renewal) ya, agar
//         kabhi update nahi hua, uske created_at ke baad. Purane cycle ke
//         SENT rows naye cycle ko block nahi karte.
// ─────────────────────────────────────────────────────────────────────────
const countPriorSends = (db, contactId, templateId) => {
  const result = db.execute(
    `SELECT COUNT(*) as count FROM message_queue mq
     JOIN contacts c ON c.id = mq.contact_id
     WHERE mq.contact_id = ? AND mq.template_id = ? AND mq.status = 'SENT'
       AND datetime(mq.sent_at) >= datetime(COALESCE(c.updated_at, c.created_at));`,
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

    // ─────────────────────────────────────────────────────────────────────────
    // FIX — Foreground resume duplicate-send bug
    // Masla: idx_queue_active_pair UNIQUE index sirf PENDING/CLAIMED rows par
    //         lagta hai. Jaise hi ek row SENT ho jaye, wo "active" nahi rehti,
    //         is liye same contact_id+template_id ka naya PENDING row bilkul
    //         insert ho sakta tha — chahe message pehle hi bhej diya gaya ho.
    //         Result: app background→foreground aane par runExpiryCheck() ka
    //         time-window check dobara true ho jata (kyunki wo sirf alarm time
    //         dekhta hai, sent-status nahi), aur wahi message dobara queue +
    //         send ho jata tha, baar baar.
    // Fix:   alreadySentCount pehle se compute ho raha tha lekin kahin use
    //         nahi ho raha tha — ab isko gate ki tarah use karo. Agar is
    //         contact+template pair ke liye ek bhi SENT row maujood hai, to
    //         naya row insert hi mat karo.
    // ─────────────────────────────────────────────────────────────────────────
    if (alreadySentCount > 0) {
      debugTrace('AddToQueueDuplicateCheckResult', { traceId, contactId, templateId, duplicateCheckResult: 'ALREADY_SENT', alreadySentCount });
      debugTraceDuration('AddToQueueDetailedExit', startTime, {
        traceId, contactId, templateId, platformId, exitReason: 'already_sent', added: false, reason: 'ALREADY_SENT',
      });
      return { added: false, reason: 'ALREADY_SENT' };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // FIX 2 — Queue ID same-millisecond collision
    // Masla: `Date.now()` milliseconds deta hai. Agar do calls ek hi millisecond
    //         mein aayein, dono ka ID bilkul ek jaisa banega. Doosra INSERT
    //         PRIMARY KEY violation deta hai jo existing UNIQUE constraint catch
    //         se alag hai — isliye silently DB_ERROR return hota tha.
    // Fix:   5-char random suffix lagao taake same-millisecond calls bhi unique
    //         IDs banayein.
    // ─────────────────────────────────────────────────────────────────────────
    const id = generateQueueId(contactId, templateId);
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
      // FIX 2 — Dono error types pakdo: UNIQUE constraint (active pair) aur
      // PRIMARY KEY (theek isi waqt doosri call ne same ID bana liya — extremely
      // rare with random suffix but still handled).
      const msg = insertError.message ?? '';
      if (msg.includes('UNIQUE constraint failed') || msg.includes('UNIQUE Index')) {
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

    // ─────────────────────────────────────────────────────────────────────────
    // FIX — Same-day PENDING rows never claimed
    // Masla: scheduled_for ISO format mein store hota hai ("...T...Z"), lekin
    //         datetime('now') SQLite ke apne format mein deta hai ("... ...",
    //         space, no 'Z'). Raw string comparison (`scheduled_for <=
    //         datetime('now')`) sirf tab sahi result deta jab dono dates
    //         (calendar day) alag hon — kyunki 'T' vs space wala character
    //         mismatch date-digits se pehle nahi aata. Same-day comparisons
    //         mein ye hamesha FALSE aata tha, chahe waqt guzr chuka ho —
    //         is liye aaj queue hua koi bhi message aaj kabhi claim/send
    //         nahi hota tha, sirf agle din (date badalne par) send hota.
    // Fix:   scheduled_for ko bhi datetime() mein wrap karo taake dono sides
    //         same normalized format mein compare hon.
    // ─────────────────────────────────────────────────────────────────────────
    const dueRows = db.execute(
      `SELECT id FROM message_queue 
       WHERE status = 'PENDING' AND datetime(scheduled_for) <= datetime('now') 
       ORDER BY scheduled_for ASC LIMIT ?;`,
      [limit],
    ).rows?._array ?? [];

    if (dueRows.length === 0) {
      debugTraceDuration('ClaimPendingQueueEnd', startTime, { callerId, claimedCount: 0, queueIds: '' });
      return [];
    }

    const ids = dueRows.map((r) => r.id);
    const placeholders = ids.map(() => '?').join(',');
    
    const claimToken = generateClaimToken(callerId);

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

// Cheap tab-badge counts — 1 GROUP BY query instead of loading every
// row just to count them client-side.
//
// FIX — Total Queued mismatch: this used to zero-initialize only
// PENDING/SENT/FAILED. Rows sitting in CLAIMED (mid-flight while
// processQueue holds them, however briefly) or SUPERSEDED (a queue row
// cancelled out from under it — e.g. its template was deactivated or
// re-scheduled while it was still PENDING) still exist in message_queue
// and still came back from this GROUP BY, but any consumer summing only
// PENDING+SENT+FAILED (see DevTestScreen.js) silently dropped them —
// Total Queued permanently undercounted the real row count for
// SUPERSEDED rows (they never transition back out of that status), and
// dipped during every processing pass while items were CLAIMED. Now every
// known status is always present in the returned object (0 if absent),
// so summing Object.values(counts) always equals the true row count.
export const getQueueCounts = () => {
  try {
    const db = getDB();
    const result = db.execute(
      `SELECT status, COUNT(*) as count FROM message_queue GROUP BY status;`,
    );
    const rows = result.rows?._array || [];
    const counts = {
      [QUEUE_STATUS.PENDING]: 0,
      [QUEUE_STATUS.CLAIMED]: 0,
      [QUEUE_STATUS.SENT]: 0,
      [QUEUE_STATUS.FAILED]: 0,
      [QUEUE_STATUS.SUPERSEDED]: 0,
    };
    rows.forEach((r) => { counts[r.status] = r.count; });
    return counts;
  } catch (error) {
    handleError(error, 'getQueueCounts');
    return { PENDING: 0, CLAIMED: 0, SENT: 0, FAILED: 0, SUPERSEDED: 0 };
  }
};

// Per-status paginated page — PENDING sorted soonest-due-first (useful
// order for "what fires next"), SENT/FAILED sorted most-recent-first.
// This replaces the old "load the whole table, filter in JS" approach
// so a queue of 500-1000 rows doesn't slow the UI down.
export const getQueuePage = (status, limit = 30, offset = 0) => {
  try {
    const db = getDB();
    const orderBy = status === 'PENDING'
      ? 'scheduled_for ASC'
      : 'COALESCE(sent_at, created_at) DESC';
    const result = db.execute(
      `SELECT * FROM message_queue WHERE status = ? ORDER BY ${orderBy} LIMIT ? OFFSET ?;`,
      [status, limit, offset],
    );
    return result.rows?._array || [];
  } catch (error) {
    handleError(error, 'getQueuePage');
    return [];
  }
};

// Same as getQueuePage but scoped to a date range. PENDING filters on
// scheduled_for (when it WILL send); SENT/FAILED filter on the moment it
// actually resolved (sent_at, falling back to created_at for FAILED rows
// that never got a sent_at). fromISO/toISO are UTC ISO strings.
export const getQueueByDateRange = (status, fromISO, toISO, limit = 30, offset = 0) => {
  try {
    const db = getDB();
    const dateCol = status === 'PENDING' ? 'scheduled_for' : 'COALESCE(sent_at, created_at)';
    const orderBy = status === 'PENDING' ? `${dateCol} ASC` : `${dateCol} DESC`;
    const result = db.execute(
      `SELECT * FROM message_queue
       WHERE status = ? AND datetime(${dateCol}) BETWEEN datetime(?) AND datetime(?)
       ORDER BY ${orderBy} LIMIT ? OFFSET ?;`,
      [status, fromISO, toISO, limit, offset],
    );
    return result.rows?._array || [];
  } catch (error) {
    handleError(error, 'getQueueByDateRange');
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

/**
 * Batch version of revertToPending — reverts many CLAIMED rows back to
 * PENDING in a single UPDATE. Used when a lane hits its rate limit and
 * breaks early (see queueProcessor.js): instead of calling revertToPending()
 * once per remaining item (N sequential DB writes on a loop that's already
 * known to fail every check), one query handles the whole batch.
 * @param {string[]} ids
 */
export const revertBatchToPending = (ids, traceId = null) => {
  if (!Array.isArray(ids) || ids.length === 0) return true;

  debugTrace('RevertBatchToPendingStart', { traceId, queueIds: ids.join(','), count: ids.length });
  try {
    const db = getDB();
    const placeholders = ids.map(() => '?').join(',');

    debugTraceDbWrite('RevertBatchToPendingUpdate', {
      table: 'message_queue', pk: ids.join(','), oldState: QUEUE_STATUS.CLAIMED, newState: QUEUE_STATUS.PENDING,
      rowCount: ids.length, traceId, reason: 'rate_limited_lane_break',
    });

    db.execute(
      `UPDATE message_queue SET status = 'PENDING', claimed_by = NULL WHERE id IN (${placeholders});`,
      ids,
    );

    debugTrace('RevertBatchToPendingEnd', { traceId, count: ids.length, status: QUEUE_STATUS.PENDING });
    return true;
  } catch (error) {
    debugTraceError('RevertBatchToPendingCatch', error, { function: 'revertBatchToPending', traceId, count: ids.length });
    handleError(error, 'revertBatchToPending');
    return false;
  }
};

/**
 * Claim a SPECIFIC queue row by ID (not all pending rows).
 * Used by fireScheduledPair so that one alarm firing only processes
 * its own message, not the entire queue.
 */
export const claimSpecificQueueItem = (id, callerId = null) => {
  try {
    const db = getDB();
    const row = getQueueRowById(id);

    if (!row || row.status !== 'PENDING') return null;

    const claimToken = generateClaimToken(callerId);

    db.execute(
      `UPDATE message_queue SET status = 'CLAIMED', claimed_by = ? WHERE id = ? AND status = 'PENDING';`,
      [claimToken, id],
    );

    const result = getQueueRowById(id);
    return result;
  } catch (error) {
    handleError(error, 'claimSpecificQueueItem');
    return null;
  }
};