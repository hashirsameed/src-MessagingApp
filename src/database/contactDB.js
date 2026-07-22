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
    
    // created_at defaults to "now" unless the caller explicitly supplies one
    const createdAtUTC = toUTCISOString(contact.created_at ?? new Date());
    
    // ✅ FIXED: Removed legacy 'expiry_date' column. Layer B uses ONLY 'expiry_datetime'
    db.execute(
      'INSERT INTO contacts (id, name, phone_number, expiry_datetime, created_at) VALUES (?, ?, ?, ?, ?);',
      [contact.id, contact.name, contact.phone_number, expiryUTC, createdAtUTC]
    );
    
    // Mutate the in-memory object too
    contact.created_at = createdAtUTC;
    logAction('contacts', contact.id, 'INSERT', null, contact);
    return true;
  } catch (error) {
    handleError(error, 'insertContact');
    return false;
  }
};

// updateContact — pure DB write. 
export const updateContact = (contact) => {
  try {
    const db = getDB();
    const before = getContactById(contact.id);
    const expiryUTC = toUTCISOString(contact.expiry_datetime);
    
    // ✅ FIXED: Removed legacy 'expiry_date' column from UPDATE query
    db.execute(
      'UPDATE contacts SET name = ?, phone_number = ?, expiry_datetime = ?, updated_at = ? WHERE id = ?;',
      [contact.name, contact.phone_number, expiryUTC, toUTCISOString(new Date()), contact.id]
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
 * Does the same DB write as updateContact(), but additionally cancels 
 * and re-schedules alarms if expiry_datetime actually changed.
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
    // Lazy require to avoid circular dependency
    const { cancelAlarmsForContact, scheduleAlarmsForContact } = require('../utils/alarmScheduler');
    const { getActiveTemplates } = require('./templateDB');

    await cancelAlarmsForContact(contact.id);
    const updated = getContactById(contact.id);
    const activeTemplates = getActiveTemplates();
    await scheduleAlarmsForContact(updated, activeTemplates);
    
    return { ok: true, rescheduled: true };
  } catch (error) {
    handleError(error, 'updateContactAndReschedule');
    return { ok: true, rescheduled: false };
  }
};