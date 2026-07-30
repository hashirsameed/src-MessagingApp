import { getDB } from './db';
import { handleError } from '../utils/errorHandler';
import { logAction } from './auditLogDB';
import { emitContactEvent } from '../utils/contactEvents';
import { toUTCISOString } from '../utils/dateFormat';

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

// Paginated, no search term — used by ContactListScreen's default (empty
// search box) list so it never loads the whole table at once.
export const getContactsPage = (limit = 30, offset = 0) => {
  try {
    const db = getDB();
    const result = db.execute(
      'SELECT * FROM contacts ORDER BY name ASC LIMIT ? OFFSET ?;',
      [limit, offset],
    );
    return result.rows?._array || [];
  } catch (error) {
    handleError(error, 'getContactsPage');
    return [];
  }
};

// Paginated name search — same page shape as getContactsPage so the
// screen can swap between the two without changing its pagination logic.
export const searchContacts = (query, limit = 30, offset = 0) => {
  try {
    const db = getDB();
    const like = `%${query}%`;
    const result = db.execute(
      `SELECT * FROM contacts WHERE name LIKE ?
       ORDER BY name ASC LIMIT ? OFFSET ?;`,
      [like, limit, offset],
    );
    return result.rows?._array || [];
  } catch (error) {
    handleError(error, 'searchContacts');
    return [];
  }
};

// Cheap total count for the "X contacts" header — a COUNT(*) instead of
// loading every row just to read its length. Same name-only LIKE filter
// as searchContacts() so the header total always matches what's on
// screen, whether that's the full list or a search result.
export const getContactsCount = (query = '') => {
  try {
    const db = getDB();
    const trimmed = (query ?? '').trim();
    if (trimmed) {
      const like = `%${trimmed}%`;
      const result = db.execute(
        'SELECT COUNT(*) as count FROM contacts WHERE name LIKE ?;',
        [like],
      );
      return result.rows?._array?.[0]?.count || 0;
    }
    const result = db.execute('SELECT COUNT(*) as count FROM contacts;');
    return result.rows?._array?.[0]?.count || 0;
  } catch (error) {
    handleError(error, 'getContactsCount');
    return 0;
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
    emitContactEvent({ type: 'INSERT', contact }); // signal: new contact, schedule its alarms
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

    const expiryChanged = before && before.expiry_datetime !== expiryUTC; // only reschedule if expiry actually moved
    emitContactEvent({ type: 'UPDATE', contact: { ...contact, expiry_datetime: expiryUTC }, expiryChanged });
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
    emitContactEvent({ type: 'DELETE', contactId: id }); // signal: contact gone, cancel its alarms
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