import { getDB } from './db';
import { handleError } from '../utils/errorHandler';
import { debugTrace, debugTraceDbWrite, debugTraceError } from '../utils/debugTrace';
import { logAction } from './auditLogDB';

// Helper to find the latest alarm for a contact/template pair via queue_id JOIN
const findLatestAlarm = (db, contactId, templateId) => db.execute(
  `SELECT sa.*, mq.contact_id, mq.template_id, mq.scheduled_for, mq.status AS queue_status
   FROM scheduled_alarms sa JOIN message_queue mq ON mq.id = sa.queue_id
   WHERE mq.contact_id = ? AND mq.template_id = ? ORDER BY sa.created_at DESC LIMIT 1;`,
  [contactId, templateId],
).rows?._array?.[0] || null;

/**
 * upsertScheduledAlarm - Layer B Atomic Cancel & Reschedule
 * Creates a 1:1 linked message_queue and scheduled_alarms row.
 * If a schedule already exists, it atomically cancels the old one and creates the new one.
 *
 * FIX 5 — Checks transaction ke andar
 * Pehle: no-op check aur already-fired check transaction ke BAHAR the. Do concurrent
 *         calls dono checks pass kar sakti thin, phir dono transaction mein ghus kar
 *         ek unhandled error deti thin.
 * Fix:   Dono checks transaction ke andar move kar diye gaye hain. Poora read-then-write
 *         ek atomic block mein hai.
 *
 * FIX 2b — queueId same-millisecond collision
 * Pehle: `q_${contactId}_${templateId}_${Date.now()}` — same millisecond mein collision.
 * Fix:   5-char random suffix add kiya.
 */
export const upsertScheduledAlarm = (contactId, templateId, requestCode, triggerAtISO, platformId = 'sms') => {
  debugTrace('UpsertScheduledAlarmStart', { contactId, templateId, requestCode, triggerAtISO });
  try {
    const db = getDB();

    // FIX 5 — Poora read-check-write ek hi transaction ke andar
    db.transaction((tx) => {

      // 1. Check if an identical schedule already exists (No-op optimization)
      const active = tx.execute(
        `SELECT * FROM message_queue WHERE contact_id=? AND template_id=? AND status IN ('PENDING','CLAIMED')
         ORDER BY created_at DESC LIMIT 1;`,
        [contactId, templateId],
      ).rows?._array?.[0] || null;

      if (active?.scheduled_for === triggerAtISO) {
        debugTrace('UpsertScheduledAlarmNoOp', { contactId, templateId, triggerAtISO });
        return; // Transaction se bahar, kuch nahi karna
      }

      // 2. Check if it was already fired for this exact trigger time (Prevent duplicate sends)
      const lastResolved = tx.execute(
        `SELECT sa.status, sa.trigger_at FROM scheduled_alarms sa
         JOIN message_queue mq ON mq.id = sa.queue_id
         WHERE mq.contact_id=? AND mq.template_id=? ORDER BY sa.created_at DESC LIMIT 1;`,
        [contactId, templateId],
      ).rows?._array?.[0] || null;

      if (lastResolved?.status === 'fired' && lastResolved.trigger_at === triggerAtISO) {
        debugTrace('UpsertScheduledAlarmSkipAlreadyFired', { contactId, templateId, triggerAtISO });
        return; // Transaction se bahar, kuch nahi karna
      }

      // 3. CANCEL PHASE — transaction ke andar
      if (active) {
        if (active.status === 'CLAIMED') {
          // In-flight send: Mark as SUPERSEDED so the worker can finish,
          // but it frees up the unique index for the new PENDING row.
          tx.execute(`UPDATE message_queue SET status = 'SUPERSEDED' WHERE id = ?;`, [active.id]);
          logAction('message_queue', active.id, 'SUPERSEDED', { status: 'CLAIMED' }, { status: 'SUPERSEDED' });

          // Cancel the associated alarm since we are rescheduling
          tx.execute(`UPDATE scheduled_alarms SET status = 'cancelled', updated_at = datetime('now') WHERE queue_id = ?;`, [active.id]);
          logAction('scheduled_alarms', active.id, 'CANCELLED', { status: 'scheduled' }, { status: 'cancelled' });
        } else {
          // PENDING: Safe to delete. ON DELETE CASCADE will automatically remove the scheduled_alarms row.
          tx.execute(`DELETE FROM message_queue WHERE id = ?;`, [active.id]);
          logAction('message_queue', active.id, 'DELETE', { status: active.status, scheduled_for: active.scheduled_for }, null);
        }
      }

      // 4. RESCHEDULE PHASE — FIX 2b: random suffix se same-millisecond collision khatam
      const queueId = `${contactId}_${templateId}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      debugTraceDbWrite('UpsertScheduledAlarmWrite', { table: 'message_queue', pk: queueId, oldState: 'none', newState: 'PENDING', contactId, templateId });

      try {
        tx.execute(
          `INSERT INTO message_queue (id, contact_id, template_id, platform_id, status, scheduled_for)
           VALUES (?, ?, ?, ?, 'PENDING', ?);`,
          [queueId, contactId, templateId, platformId, triggerAtISO],
        );
      } catch (raceError) {
        // The partial unique index caught a concurrent insert for the same (contact, template) pair
        debugTrace('UpsertScheduledAlarmRaceLost', { contactId, templateId, triggerAtISO, error: String(raceError) });
        throw raceError; // Rollback transaction and let outer catch handle it
      }

      logAction('message_queue', queueId, 'INSERT', null, { contact_id: contactId, template_id: templateId, scheduled_for: triggerAtISO, status: 'PENDING' });

      tx.execute(
        `INSERT INTO scheduled_alarms (queue_id, request_code, trigger_at, status) VALUES (?, ?, ?, 'scheduled');`,
        [queueId, requestCode, triggerAtISO],
      );
      logAction('scheduled_alarms', queueId, 'INSERT', null, { trigger_at: triggerAtISO, request_code: requestCode });

      debugTrace('UpsertScheduledAlarmEnd', { contactId, templateId, requestCode, queueId });
    });

    return true;
  } catch (error) {
    debugTraceError('UpsertScheduledAlarmCatch', error, { function: 'upsertScheduledAlarm', contactId, templateId });
    handleError(error, 'upsertScheduledAlarm');
    return false;
  }
};

export const getScheduledAlarm = (contactId, templateId) => {
  try {
    return findLatestAlarm(getDB(), contactId, templateId);
  } catch (error) {
    handleError(error, 'getScheduledAlarm');
    return null;
  }
};

export const getScheduledAlarmsByContact = (contactId) => {
  try {
    const result = getDB().execute(
      `SELECT sa.*, mq.contact_id, mq.template_id, mq.scheduled_for, mq.status AS queue_status
       FROM scheduled_alarms sa JOIN message_queue mq ON mq.id = sa.queue_id
       WHERE mq.contact_id = ? ORDER BY sa.trigger_at ASC;`,
      [contactId],
    );
    return result.rows?._array || [];
  } catch (error) {
    handleError(error, 'getScheduledAlarmsByContact');
    return [];
  }
};

export const getScheduledAlarmsByTemplate = (templateId) => {
  try {
    const result = getDB().execute(
      `SELECT sa.*, mq.contact_id, mq.template_id, mq.scheduled_for, mq.status AS queue_status
       FROM scheduled_alarms sa JOIN message_queue mq ON mq.id = sa.queue_id
       WHERE mq.template_id = ? ORDER BY sa.trigger_at ASC;`,
      [templateId],
    );
    return result.rows?._array || [];
  } catch (error) {
    handleError(error, 'getScheduledAlarmsByTemplate');
    return [];
  }
};

export const getAllActiveScheduledAlarms = () => {
  try {
    const result = getDB().execute(
      `SELECT sa.id, sa.queue_id, sa.request_code, sa.trigger_at, sa.status, mq.contact_id, mq.template_id
       FROM scheduled_alarms sa JOIN message_queue mq ON mq.id = sa.queue_id
       WHERE sa.status = 'scheduled' ORDER BY sa.trigger_at ASC;`,
    );
    return result.rows?._array || [];
  } catch (error) {
    handleError(error, 'getAllActiveScheduledAlarms');
    return [];
  }
};

export const getDueScheduledAlarms = () => {
  try {
    const result = getDB().execute(
      `SELECT sa.id, sa.queue_id, sa.request_code, sa.trigger_at, sa.status, mq.contact_id, mq.template_id
       FROM scheduled_alarms sa JOIN message_queue mq ON mq.id = sa.queue_id
       WHERE sa.status = 'scheduled' AND datetime(sa.trigger_at) <= datetime('now') ORDER BY sa.trigger_at ASC;`,
    );
    return result.rows?._array || [];
  } catch (error) {
    handleError(error, 'getDueScheduledAlarms');
    return [];
  }
};

const updateAlarmStatus = (contactId, templateId, fromStatuses, toStatus, action) => {
  try {
    const db = getDB();
    const placeholders = fromStatuses.map(() => '?').join(',');
    const row = db.execute(
      `SELECT sa.id, sa.status FROM scheduled_alarms sa JOIN message_queue mq ON mq.id = sa.queue_id
       WHERE mq.contact_id = ? AND mq.template_id = ? AND sa.status IN (${placeholders})
       ORDER BY sa.created_at DESC LIMIT 1;`,
      [contactId, templateId, ...fromStatuses],
    ).rows?._array?.[0];

    if (!row) return false;

    debugTraceDbWrite(`${action}Update`, { table: 'scheduled_alarms', pk: row.id, oldState: row.status, newState: toStatus, contactId, templateId });
    db.execute(`UPDATE scheduled_alarms SET status = ?, updated_at = datetime('now') WHERE id = ?;`, [toStatus, row.id]);
    logAction('scheduled_alarms', String(row.id), action, { status: row.status }, { status: toStatus });
    return true;
  } catch (error) {
    debugTraceError(`${action}Catch`, error, { function: action, contactId, templateId });
    handleError(error, action);
    return false;
  }
};

export const markScheduledAlarmCancelled = (contactId, templateId) =>
  updateAlarmStatus(contactId, templateId, ['scheduled', 'firing'], 'cancelled', 'CANCELLED');

export const markScheduledAlarmFired = (contactId, templateId) =>
  updateAlarmStatus(contactId, templateId, ['scheduled', 'firing'], 'fired', 'FIRED');

export const claimScheduledAlarmForFiring = (contactId, templateId) => {
  debugTrace('ClaimScheduledAlarmStart', { contactId, templateId });
  try {
    const db = getDB();
    const before = findLatestAlarm(db, contactId, templateId);
    if (!before) return { claimed: false, row: null };

    const result = db.execute(
      `UPDATE scheduled_alarms SET status = 'firing', updated_at = datetime('now') WHERE id = ? AND status = 'scheduled';`,
      [before.id],
    );
    const claimed = (result?.rowsAffected ?? 0) > 0;

    debugTraceDbWrite('ClaimScheduledAlarmCAS', { table: 'scheduled_alarms', pk: before.id, oldState: before.status, newState: claimed ? 'firing' : before.status, contactId, templateId });

    if (!claimed) return { claimed: false, row: before };

    logAction('scheduled_alarms', String(before.id), 'CLAIMED', { status: before.status }, { status: 'firing' });
    return { claimed: true, row: { ...before, status: 'firing', contact_id: contactId, template_id: templateId } };
  } catch (error) {
    debugTraceError('ClaimScheduledAlarmCatch', error, { function: 'claimScheduledAlarmForFiring', contactId, templateId });
    handleError(error, 'claimScheduledAlarmForFiring');
    return { claimed: false, row: null };
  }
};

export const releaseScheduledAlarmClaim = (contactId, templateId) => {
  try {
    const db = getDB();
    const row = db.execute(
      `SELECT sa.id FROM scheduled_alarms sa JOIN message_queue mq ON mq.id = sa.queue_id
       WHERE mq.contact_id = ? AND mq.template_id = ? AND sa.status = 'firing' ORDER BY sa.created_at DESC LIMIT 1;`,
      [contactId, templateId],
    ).rows?._array?.[0];
    if (!row) return false;

    const result = db.execute(
      `UPDATE scheduled_alarms SET status = 'scheduled', updated_at = datetime('now') WHERE id = ? AND status = 'firing';`,
      [row.id],
    );
    const released = (result?.rowsAffected ?? 0) > 0;
    if (released) logAction('scheduled_alarms', String(row.id), 'RELEASED', { status: 'firing' }, { status: 'scheduled' });
    return released;
  } catch (error) {
    debugTraceError('ReleaseScheduledAlarmClaimCatch', error, { function: 'releaseScheduledAlarmClaim', contactId, templateId });
    handleError(error, 'releaseScheduledAlarmClaim');
    return false;
  }
};

export const getNextUpcomingAlarm = () => {
  try {
    const result = getDB().execute(
      `SELECT mq.contact_id, mq.template_id, sa.trigger_at, c.name AS contact_name, t.title AS template_title
       FROM scheduled_alarms sa
       JOIN message_queue mq ON mq.id = sa.queue_id
       JOIN contacts c ON c.id = mq.contact_id
       JOIN templates t ON t.id = mq.template_id
       WHERE sa.status = 'scheduled' ORDER BY sa.trigger_at ASC LIMIT 1;`,
    );
    return result.rows?._array?.[0] || null;
  } catch (error) {
    handleError(error, 'getNextUpcomingAlarm');
    return null;
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// FIX 6 — cancelAllScheduledAlarmsBy atomic banaya
// Pehle: SELECT se list parhi, phir alag UPDATE kiya. Dono ke darmiyan koi aur
//         alarm fire kar sakta tha — audit log mein wo action record nahi hoti.
// Fix:   Ek hi UPDATE statement jisme WHERE clause directly condition check kare.
//         Phir audit log ke liye affected rows parhe jayen.
// ─────────────────────────────────────────────────────────────────────────────
const cancelAllScheduledAlarmsBy = (column, value) => {
  try {
    const db = getDB();
    let toCancel = [];
    let confirmedIds = new Set();

    // FIX 6b — SELECT + UPDATE ab ek real db.transaction() ke andar hain, taake
    // native side (PersistentReminderService.kt) se koi cross-process write
    // beech mein na aa sake — pehle ka "atomic" comment sach nahi tha, do
    // separate statements the.
    db.transaction((tx) => {
      toCancel = tx.execute(
        `SELECT sa.id, sa.request_code, mq.contact_id, mq.template_id
         FROM scheduled_alarms sa
         JOIN message_queue mq ON mq.id = sa.queue_id
         WHERE mq.${column} = ? AND sa.status = 'scheduled';`,
        [value],
      ).rows?._array || [];

      if (!toCancel.length) return;

      const placeholders = toCancel.map(() => '?').join(',');

      // Sirf wo rows cancel karo jo abhi bhi 'scheduled' hain. Agar SELECT aur
      // UPDATE ke darmiyan koi 'firing' ho gaya, wo guard se skip ho jayegi.
      db.execute(
        `UPDATE scheduled_alarms
         SET status = 'cancelled', updated_at = datetime('now')
         WHERE id IN (${placeholders}) AND status = 'scheduled';`,
        toCancel.map((r) => r.id),
      );

      // FIX 6b — Re-verify: audit log sirf un rows ke liye likho jo UPDATE ne
      // waqai cancel ki hain. Pehle poori toCancel list unconditionally log ho
      // rahi thi, chahe guard ne kisi row ko skip kiya ho — galat "CANCELLED"
      // audit entry ban sakti thi us row ke liye jo asal mein cancel hi nahi hui.
      const confirmed = db.execute(
        `SELECT id FROM scheduled_alarms WHERE id IN (${placeholders}) AND status = 'cancelled';`,
        toCancel.map((r) => r.id),
      ).rows?._array || [];
      confirmedIds = new Set(confirmed.map((r) => r.id));
    });

    const confirmedRows = toCancel.filter((row) => confirmedIds.has(row.id));

    confirmedRows.forEach((row) =>
      logAction('scheduled_alarms', String(row.id), 'CANCELLED', { status: 'scheduled' }, { status: 'cancelled' }),
    );
    return confirmedRows;
  } catch (error) {
    handleError(error, `cancelAllScheduledAlarmsBy_${column}`);
    return [];
  }
};

export const cancelAllScheduledAlarmsForContact = (contactId) => cancelAllScheduledAlarmsBy('contact_id', contactId);
export const cancelAllScheduledAlarmsForTemplate = (templateId) => cancelAllScheduledAlarmsBy('template_id', templateId);

/**
 * deleteScheduledAlarm - Optimized for Layer B Cascade
 * Deletes from message_queue. The ON DELETE CASCADE FK automatically 
 * removes the linked scheduled_alarms row, ensuring zero orphans.
 */
export const deleteScheduledAlarm = (contactId, templateId) => {
  try {
    const db = getDB();
    const row = db.execute(
      `SELECT mq.id FROM message_queue mq
       WHERE mq.contact_id = ? AND mq.template_id = ? AND status IN ('PENDING', 'CLAIMED')
       ORDER BY mq.created_at DESC LIMIT 1;`,
      [contactId, templateId],
    ).rows?._array?.[0];
    
    if (!row) return true;

    db.execute(`DELETE FROM message_queue WHERE id = ?;`, [row.id]);
    logAction('message_queue', row.id, 'DELETE', null, null);
    return true;
  } catch (error) {
    handleError(error, 'deleteScheduledAlarm');
    return false;
  }
};