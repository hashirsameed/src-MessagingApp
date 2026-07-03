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

    db.execute(
      `
      INSERT INTO scheduled_alarms (id, contact_id, template_id, request_code, trigger_at, status, updated_at)
      VALUES (?, ?, ?, ?, ?, 'scheduled', datetime('now'))
      ON CONFLICT(id) DO UPDATE SET
        request_code = excluded.request_code,
        trigger_at   = excluded.trigger_at,
        status       = 'scheduled',
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