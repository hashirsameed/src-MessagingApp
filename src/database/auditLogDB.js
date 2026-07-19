import { getDB } from './db';
import { handleError } from '../utils/errorHandler';

/**
 * logAction — records one row mutation into db_action_log.
 *
 * This is a pure observation layer: it never changes what the caller's
 * write actually did, and a failure here must never fail the caller's
 * operation. old_value / new_value are whatever plain object the caller
 * had on hand (a full contact, a scheduled_alarms row, etc.) — stored as
 * JSON so this stays generic across every table it's used for.
 *
 * table_name: which table changed, e.g. 'contacts', 'scheduled_alarms'
 * row_id: the primary/natural key of the affected row (contact.id,
 *   or `${contactId}:${templateId}` for scheduled_alarms)
 * action: 'INSERT' | 'UPDATE' | 'DELETE' | a more specific verb like
 *   'FIRED' / 'CANCELLED' / 'CLAIMED' / 'RELEASED' where that's clearer
 *   than a generic UPDATE
 */
export const logAction = (tableName, rowId, action, oldValue = null, newValue = null) => {
  try {
    const db = getDB();
    db.execute(
      `INSERT INTO db_action_log (table_name, row_id, action, old_value, new_value, occurred_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'));`,
      [
        tableName,
        String(rowId),
        action,
        oldValue === null ? null : JSON.stringify(oldValue),
        newValue === null ? null : JSON.stringify(newValue),
      ],
    );
  } catch (error) {
    // Never let a logging failure take down the real operation that
    // triggered it — this is strictly best-effort observability.
    handleError(error, 'auditLogDB.logAction');
  }
};

/**
 * getAuditLog — read back recent history for one row, newest first.
 * Used by the Test panel's "View Log" and by anyone debugging "what
 * happened to this contact/alarm, in what order."
 */
export const getAuditLog = (tableName, rowId, limit = 20) => {
  try {
    const db = getDB();
    const result = db.execute(
      `SELECT * FROM db_action_log
       WHERE table_name = ? AND row_id = ?
       ORDER BY occurred_at DESC, id DESC
       LIMIT ?;`,
      [tableName, String(rowId), limit],
    );
    return result.rows?._array || [];
  } catch (error) {
    handleError(error, 'auditLogDB.getAuditLog');
    return [];
  }
};