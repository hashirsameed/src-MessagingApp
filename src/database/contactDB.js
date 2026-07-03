import { getDB } from './db';
import { handleError } from '../utils/errorHandler';

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
    db.execute(
      'INSERT INTO contacts (id, name, phone_number, expiry_date, expiry_datetime) VALUES (?, ?, ?, ?, ?);',
      [contact.id, contact.name, contact.phone_number, legacyDate, expiryUTC]
    );
    return true;
  } catch (error) {
    handleError(error, 'insertContact');
    return false;
  }
};

export const updateContact = (contact) => {
  try {
    const db = getDB();
    const expiryUTC = toUTCISOString(contact.expiry_datetime);
    const legacyDate = toLegacyDateOnly(expiryUTC);
    db.execute(
      'UPDATE contacts SET name = ?, phone_number = ?, expiry_date = ?, expiry_datetime = ? WHERE id = ?;',
      [contact.name, contact.phone_number, legacyDate, expiryUTC, contact.id]
    );
    return true;
  } catch (error) {
    handleError(error, 'updateContact');
    return false;
  }
};

export const deleteContact = (id) => {
  try {
    const db = getDB();
    db.execute('DELETE FROM contacts WHERE id = ?;', [id]);
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