import { getDB } from './db';
import { handleError } from '../utils/errorHandler';
import { logAction } from './auditLogDB';

// ---------------------------------------------------------------------------
// Datetime helpers — all stored/queried values are UTC ISO strings,
// e.g. "2026-07-15T09:30:00Z" (no milliseconds, always 'Z' suffix).
// ---------------------------------------------------------------------------
const toUTCISOString = (input) => {
  const d = input instanceof Date ? input : new Date(input);
  if (isNaN(d.getTime())) {
    throw new Error(`Invalid datetime value: ${input}`);
  }
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
};

// Extracts just the YYYY-MM-DD part from a UTC ISO datetime string,
// to satisfy the legacy expiry_date NOT NULL column.
const toLegacyDateOnly = (isoUTC) => isoUTC.slice(0, 10);

export const getAllContacts = () => {
  try {
    const db = getDB();
    const result = db.execute('SELECT * FROM contacts ORDER BY name ASC;');
    return result.rows?._array || [];
  } catch (error) {
    handleError(error, 'getAllContacts');
    return [];
  }
};

export const insertContact = (contact) => {
  try {
    const db = getDB();
    const expiryUTC = toUTCISOString(contact.expiry_datetime);
    const legacyDate = toLegacyDateOnly(expiryUTC);
    // created_at defaults to "now" (the moment the contact actually enters
    // the system) unless the caller explicitly supplies one — e.g. a bulk
    // import that wants to backdate it.
    const createdAtUTC = toUTCISOString(contact.created_at ?? new Date());
    db.execute(
      'INSERT INTO contacts (id, name, phone_number, expiry_date, expiry_datetime, created_at) VALUES (?, ?, ?, ?, ?, ?);',
      [contact.id, contact.name, contact.phone_number, legacyDate, expiryUTC, createdAtUTC]
    );
    // Mutate the in-memory object too — callers such as AddContactScreen
    // pass this same object straight into scheduleAlarmsForContact right
    // after insertContact() returns, so it needs created_at set on it,
    // not just in the DB row.
    contact.created_at = createdAtUTC;
    logAction('contacts', contact.id, 'INSERT', null, contact);
    return true;
  } catch (error) {
    handleError(error, 'insertContact');
    return false;
  }
};

// updateContact — pure DB write. Deliberately does NOT touch scheduling
// (no cancel/reschedule of scheduled_alarms) — the Test panel's "Update
// Time" button calls this directly and depends on that: it changes
// contacts.expiry_datetime and leaves scheduled_alarms exactly as-is, so
// whatever the real background logic (SafetyNetTask / ReconcilerTask)
// does with the now-changed contact is the thing being observed, not
// something this function simulates itself.
//
// For a genuine "user edited this contact's expiry, so re-schedule it"
// flow, use updateContactAndReschedule() below instead — same DB write,
// plus the real cancel+reschedule side effect.
export const updateContact = (contact) => {
  try {
    const db = getDB();
    const before = getContactById(contact.id);
    const expiryUTC = toUTCISOString(contact.expiry_datetime);
    const legacyDate = toLegacyDateOnly(expiryUTC);
    db.execute(
      'UPDATE contacts SET name = ?, phone_number = ?, expiry_date = ?, expiry_datetime = ? WHERE id = ?;',
      [contact.name, contact.phone_number, legacyDate, expiryUTC, contact.id]
    );
    logAction('contacts', contact.id, 'UPDATE', before, { ...contact, expiry_datetime: expiryUTC });
    return true;
  } catch (error) {
    handleError(error, 'updateContact');
    return false;
  }
};

export const deleteContact = (id) => {
  try {
    const db = getDB();
    const before = getContactById(id);
    db.execute('DELETE FROM contacts WHERE id = ?;', [id]);
    logAction('contacts', id, 'DELETE', before, null);
    return true;
  } catch (error) {
    handleError(error, 'deleteContact');
    return false;
  }
};

export const getExpiringContacts = (startDate, endDate) => {
  try {
    const db = getDB();
    const start = startDate ? toUTCISOString(startDate) : toUTCISOString(new Date());
    const end = endDate
      ? toUTCISOString(endDate)
      : toUTCISOString(new Date(Date.now() + 365 * 24 * 60 * 60 * 1000));

    const result = db.execute(
      `
      SELECT * FROM contacts
      WHERE datetime(expiry_datetime) >= datetime(?)
      AND datetime(expiry_datetime) <= datetime(?)
      ORDER BY expiry_datetime ASC;
      `,
      [start, end]
    );
    return result.rows?._array || [];
  } catch (error) {
    handleError(error, 'getExpiringContacts');
    return [];
  }
};

export const getContactById = (id) => {
  try {
    const db = getDB();
    const result = db.execute('SELECT * FROM contacts WHERE id = ?;', [id]);
    return result.rows?._array?.[0] || null;
  } catch (error) {
    handleError(error, 'getContactById');
    return null;
  }
};

/**
 * updateContactAndReschedule — the real "user edited this contact" path.
 * Does the same DB write as updateContact(), but additionally: if
 * expiry_datetime actually changed, cancels the contact's existing
 * scheduled_alarms and re-schedules fresh ones against the new expiry —
 * so an edited contact's reminders point at the correct new time instead
 * of the stale one.
 *
 * Deliberately a separate function from updateContact() rather than
 * baking this into updateContact() itself, for two reasons:
 *   1. Circular import — alarmScheduler.js already imports contactDB.js
 *      (getAllContacts), so contactDB.js can't import alarmScheduler.js
 *      at the top level without creating a cycle. Lazy `require` here
 *      avoids that (same pattern already used in alarmScheduler.js's
 *      own boot-recovery code).
 *   2. The Test panel's "Update Time" button calls updateContact()
 *      directly and depends on it NOT touching scheduled_alarms — that's
 *      what makes it useful for testing SafetyNetTask/ReconcilerTask
 *      behavior against a manually-changed expiry. Folding rescheduling
 *      into updateContact() itself would silently break that test tool.
 */
export const updateContactAndReschedule = async (contact) => {
  const before = getContactById(contact.id);
  const expiryChanged = before && before.expiry_datetime !== toUTCISOString(contact.expiry_datetime);

  const ok = updateContact(contact);
  if (!ok) return { ok: false, rescheduled: false };

  if (!expiryChanged) {
    return { ok: true, rescheduled: false };
  }

  try {
    // Lazy require — see note above on why this can't be a top-level import.
    const { cancelAlarmsForContact, scheduleAlarmsForContact } = require('../utils/alarmScheduler');
    const { getActiveTemplates } = require('./templateDB');

    await cancelAlarmsForContact(contact.id);
    const updated = getContactById(contact.id);
    const activeTemplates = getActiveTemplates();
    await scheduleAlarmsForContact(updated, activeTemplates);
    return { ok: true, rescheduled: true };
  } catch (error) {
    handleError(error, 'updateContactAndReschedule');
    // The contact row itself was already updated successfully above;
    // only the reschedule step failed, so report that distinction
    // rather than a blanket failure.
    return { ok: true, rescheduled: false };
  }
};