import { getDB } from './db';
import { handleError } from '../utils/errorHandler';
import { debugTrace, debugTraceDbWrite, debugTraceError } from '../utils/debugTrace';

const makeId = (contactId, templateId) => `${contactId}_${templateId}`;

/**
 * Point 8 — Alarm schedule count sanity check. Logs how many scheduled_alarms
 * rows currently exist for this contact and for this template AFTER an
 * upsert. Since the UNIQUE(contact_id, template_id) constraint should make
 * exactly one row per pair impossible to duplicate, seeing more than the
 * expected count here (e.g. contactAlarmCount higher than active-template
 * count) is a direct signal something is wrong upstream — without this,
 * a silent double-schedule would only surface as a duplicate SMS days later.
 */
const logAlarmCounts = (db, contactId, templateId) => {
  const contactCount = db.execute(
    `SELECT COUNT(*) as count FROM scheduled_alarms WHERE contact_id = ? AND status = 'scheduled';`,
    [contactId],
  ).rows?._array?.[0]?.count ?? 0;

  const templateCount = db.execute(
    `SELECT COUNT(*) as count FROM scheduled_alarms WHERE template_id = ? AND status = 'scheduled';`,
    [templateId],
  ).rows?._array?.[0]?.count ?? 0;

  debugTrace('AlarmScheduleCountCheck', {
    contactId,
    templateId,
    activeAlarmsForContact: contactCount,
    activeAlarmsForTemplate: templateCount,
  });
};

export const upsertScheduledAlarm = (contactId, templateId, requestCode, triggerAtISO) => {
  debugTrace('UpsertScheduledAlarmStart', { contactId, templateId, requestCode, triggerAtISO });
  try {
    const db = getDB();
    const id = makeId(contactId, templateId);

    const existing = db.execute('SELECT status FROM scheduled_alarms WHERE id = ?;', [id])
      .rows?._array?.[0];

    debugTraceDbWrite('UpsertScheduledAlarmWrite', {
      table: 'scheduled_alarms',
      pk: id,
      oldState: existing?.status ?? 'none',
      newState: 'scheduled',
      contactId,
      templateId,
      requestCode,
      triggerAtISO,
    });

    // status only resets to 'scheduled' when this is genuinely a new cycle
    // (trigger_at actually changed). If trigger_at is identical to what's
    // already stored and the row is 'fired'/'firing', a reschedule pass
    // (template edit/create, contact add) must NOT resurrect an alarm that
    // already sent — that was silently reviving already-sent pairs and
    // causing the duplicate-send-minutes-later bug.
    db.execute(
      `
      INSERT INTO scheduled_alarms (id, contact_id, template_id, request_code, trigger_at, status, updated_at)
      VALUES (?, ?, ?, ?, ?, 'scheduled', datetime('now'))
      ON CONFLICT(id) DO UPDATE SET
        request_code = excluded.request_code,
        trigger_at   = excluded.trigger_at,
        status       = CASE
                          WHEN status IN ('fired', 'firing')
                               AND trigger_at = excluded.trigger_at
                          THEN status
                          ELSE 'scheduled'
                        END,
        updated_at   = datetime('now');
      `,
      [id, contactId, templateId, requestCode, triggerAtISO],
    );

    logAlarmCounts(db, contactId, templateId);

    debugTrace('UpsertScheduledAlarmEnd', { contactId, templateId, requestCode, pk: id });
    return true;
  } catch (error) {
    debugTraceError('UpsertScheduledAlarmCatch', error, {
      function: 'upsertScheduledAlarm', contactId, templateId, requestCode,
    });
    handleError(error, 'upsertScheduledAlarm');
    return false;
  }
};

export const getScheduledAlarm = (contactId, templateId) => {
  try {
    const db = getDB();
    const id = makeId(contactId, templateId);
    const result = db.execute('SELECT * FROM scheduled_alarms WHERE id = ?;', [id]);
    const row = result.rows?._array?.[0] || null;
    debugTrace('GetScheduledAlarm', {
      contactId,
      templateId,
      pk: id,
      found: !!row,
      status: row?.status ?? 'not_found',
      triggerAt: row?.trigger_at ?? '',
      requestCode: row?.request_code ?? '',
    });
    return row;
  } catch (error) {
    debugTraceError('GetScheduledAlarmCatch', error, {
      function: 'getScheduledAlarm',
      contactId,
      templateId,
    });
    handleError(error, 'getScheduledAlarm');
    return null;
  }
};

export const getScheduledAlarmsByContact = (contactId) => {
  try {
    const db = getDB();
    const result = db.execute(
      'SELECT * FROM scheduled_alarms WHERE contact_id = ?;',
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
    const db = getDB();
    const result = db.execute(
      'SELECT * FROM scheduled_alarms WHERE template_id = ?;',
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
    const db = getDB();
    const result = db.execute(
      `SELECT * FROM scheduled_alarms WHERE status = 'scheduled' ORDER BY trigger_at ASC;`,
    );
    return result.rows?._array || [];
  } catch (error) {
    handleError(error, 'getAllActiveScheduledAlarms');
    return [];
  }
};

/**
 * getDueScheduledAlarms — Level 1 (Active Queue / Micro Safety-Net) source.
 * Every row still 'scheduled' whose trigger_at has already passed. This is
 * the same status/table AlarmFiredTask itself operates on — no separate
 * rescan-and-filter logic, no independent grace-period rule. Reuses
 * idx_scheduled_alarms_status.
 */
export const getDueScheduledAlarms = () => {
  try {
    const db = getDB();
    const result = db.execute(
      `SELECT * FROM scheduled_alarms
       WHERE status = 'scheduled' AND trigger_at <= datetime('now')
       ORDER BY trigger_at ASC;`,
    );
    return result.rows?._array || [];
  } catch (error) {
    handleError(error, 'getDueScheduledAlarms');
    return [];
  }
};

export const markScheduledAlarmCancelled = (contactId, templateId) => {
  debugTrace('MarkScheduledAlarmCancelledStart', { contactId, templateId });
  try {
    const db = getDB();
    const id = makeId(contactId, templateId);
    const existing = db.execute('SELECT status FROM scheduled_alarms WHERE id = ?;', [id])
      .rows?._array?.[0];
    debugTraceDbWrite('MarkScheduledAlarmCancelledUpdate', {
      table: 'scheduled_alarms',
      pk: id,
      oldState: existing?.status ?? 'unknown',
      newState: 'cancelled',
      contactId,
      templateId,
    });
    db.execute(
      `UPDATE scheduled_alarms SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?;`,
      [id],
    );
    debugTrace('MarkScheduledAlarmCancelledEnd', {
      contactId,
      templateId,
      status: 'cancelled',
    });
    return true;
  } catch (error) {
    debugTraceError('MarkScheduledAlarmCancelledCatch', error, {
      function: 'markScheduledAlarmCancelled',
      contactId,
      templateId,
    });
    handleError(error, 'markScheduledAlarmCancelled');
    return false;
  }
};

export const markScheduledAlarmFired = (contactId, templateId) => {
  debugTrace('MarkScheduledAlarmFiredStart', { contactId, templateId });
  try {
    const db = getDB();
    const id = makeId(contactId, templateId);
    const existing = db.execute('SELECT status FROM scheduled_alarms WHERE id = ?;', [id])
      .rows?._array?.[0];
    debugTraceDbWrite('MarkScheduledAlarmFiredUpdate', {
      table: 'scheduled_alarms',
      pk: id,
      oldState: existing?.status ?? 'unknown',
      newState: 'fired',
      contactId,
      templateId,
    });
    db.execute(
      `UPDATE scheduled_alarms SET status = 'fired', updated_at = datetime('now') WHERE id = ?;`,
      [id],
    );
    debugTrace('MarkScheduledAlarmFiredEnd', {
      contactId,
      templateId,
      status: 'fired',
    });
    return true;
  } catch (error) {
    debugTraceError('MarkScheduledAlarmFiredCatch', error, {
      function: 'markScheduledAlarmFired',
      contactId,
      templateId,
    });
    handleError(error, 'markScheduledAlarmFired');
    return false;
  }
};

/**
 * claimScheduledAlarmForFiring — atomic CAS guard.
 *
 * Single gatekeeper every trigger source (AlarmReceiver, ExpirySafetyNetWorker,
 * BootReceiver-driven reschedule) must pass through before touching
 * messageQueueDB. The UPDATE only succeeds if the row is still 'scheduled'
 * at the moment of the call. Returns { claimed, row }.
 */
export const claimScheduledAlarmForFiring = (contactId, templateId) => {
  debugTrace('ClaimScheduledAlarmStart', { contactId, templateId });
  try {
    const db = getDB();
    const id = makeId(contactId, templateId);

    const before = db.execute('SELECT * FROM scheduled_alarms WHERE id = ?;', [id])
      .rows?._array?.[0] || null;

    if (!before) {
      debugTrace('ClaimScheduledAlarmMiss', { contactId, templateId, reason: 'row_not_found' });
      return { claimed: false, row: null };
    }

    const result = db.execute(
      `UPDATE scheduled_alarms
       SET status = 'firing', updated_at = datetime('now')
       WHERE id = ? AND status = 'scheduled';`,
      [id],
    );

    const rowsAffected = result?.rowsAffected ?? 0;

    debugTraceDbWrite('ClaimScheduledAlarmCAS', {
      table: 'scheduled_alarms',
      pk: id,
      oldState: before.status,
      newState: rowsAffected > 0 ? 'firing' : before.status,
      rowsAffected,
      contactId,
      templateId,
    });

    if (rowsAffected === 0) {
      debugTrace('ClaimScheduledAlarmSkip', {
        contactId, templateId, reason: 'already_claimed_or_not_scheduled', currentStatus: before.status,
      });
      return { claimed: false, row: before };
    }

    const after = db.execute('SELECT * FROM scheduled_alarms WHERE id = ?;', [id])
      .rows?._array?.[0] || null;

    debugTrace('ClaimScheduledAlarmEnd', { contactId, templateId, claimed: true });
    return { claimed: true, row: after };
  } catch (error) {
    debugTraceError('ClaimScheduledAlarmCatch', error, {
      function: 'claimScheduledAlarmForFiring', contactId, templateId,
    });
    handleError(error, 'claimScheduledAlarmForFiring');
    return { claimed: false, row: null };
  }
};

/**
 * releaseScheduledAlarmClaim — reverts a 'firing' claim back to 'scheduled'.
 * Only used when a claimed alarm fails to queue for a transient reason
 * (DB error, etc.) so the safety-net worker can retry it later instead of
 * the row being stuck permanently in 'firing'.
 */
export const releaseScheduledAlarmClaim = (contactId, templateId) => {
  try {
    const db = getDB();
    const id = makeId(contactId, templateId);
    const result = db.execute(
      `UPDATE scheduled_alarms SET status = 'scheduled', updated_at = datetime('now')
       WHERE id = ? AND status = 'firing';`,
      [id],
    );
    debugTrace('ReleaseScheduledAlarmClaim', {
      contactId, templateId, rowsAffected: result?.rowsAffected ?? 0,
    });
    return (result?.rowsAffected ?? 0) > 0;
  } catch (error) {
    debugTraceError('ReleaseScheduledAlarmClaimCatch', error, {
      function: 'releaseScheduledAlarmClaim', contactId, templateId,
    });
    handleError(error, 'releaseScheduledAlarmClaim');
    return false;
  }
};

/**
 * getNextUpcomingAlarm — read-only, part of the engine's published UI
 * interface. Used by notification builder, widget (Kotlin mirrors this
 * same query independently), and Settings/status screens. Never call from
 * write paths.
 */
export const getNextUpcomingAlarm = () => {
  try {
    const db = getDB();
    const result = db.execute(
      `
      SELECT sa.contact_id, sa.template_id, sa.trigger_at,
             c.name AS contact_name, t.title AS template_title
      FROM scheduled_alarms sa
      JOIN contacts c ON c.id = sa.contact_id
      JOIN templates t ON t.id = sa.template_id
      WHERE sa.status = 'scheduled'
      ORDER BY sa.trigger_at ASC
      LIMIT 1;
      `,
    );
    return result.rows?._array?.[0] || null;
  } catch (error) {
    handleError(error, 'getNextUpcomingAlarm');
    return null;
  }
};

export const cancelAllScheduledAlarmsForContact = (contactId) => {
  try {
    const db = getDB();
    const toCancel = db.execute(
      `SELECT * FROM scheduled_alarms WHERE contact_id = ? AND status = 'scheduled';`,
      [contactId],
    ).rows?._array || [];

    db.execute(
      `UPDATE scheduled_alarms SET status = 'cancelled', updated_at = datetime('now')
       WHERE contact_id = ? AND status = 'scheduled';`,
      [contactId],
    );

    return toCancel;
  } catch (error) {
    handleError(error, 'cancelAllScheduledAlarmsForContact');
    return [];
  }
};

export const cancelAllScheduledAlarmsForTemplate = (templateId) => {
  try {
    const db = getDB();
    const toCancel = db.execute(
      `SELECT * FROM scheduled_alarms WHERE template_id = ? AND status = 'scheduled';`,
      [templateId],
    ).rows?._array || [];

    db.execute(
      `UPDATE scheduled_alarms SET status = 'cancelled', updated_at = datetime('now')
       WHERE template_id = ? AND status = 'scheduled';`,
      [templateId],
    );

    return toCancel;
  } catch (error) {
    handleError(error, 'cancelAllScheduledAlarmsForTemplate');
    return [];
  }
};

export const deleteScheduledAlarm = (contactId, templateId) => {
  try {
    const db = getDB();
    const id = makeId(contactId, templateId);
    db.execute('DELETE FROM scheduled_alarms WHERE id = ?;', [id]);
    return true;
  } catch (error) {
    handleError(error, 'deleteScheduledAlarm');
    return false;
  }
};