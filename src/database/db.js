import { open } from 'react-native-quick-sqlite';

let db = null;

export const getDB = () => {
  if (db) return db;

  try {
    db = open({ name: 'MessagingApp.db' });

    db.execute(`
      CREATE TABLE IF NOT EXISTS templates (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
      );
    `);

    try {
      db.execute(`ALTER TABLE templates ADD COLUMN days_before INTEGER NOT NULL DEFAULT 1;`);
    } catch (_) {}
    try {
      db.execute(`ALTER TABLE templates ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1;`);
    } catch (_) {}
    try {
      db.execute(`ALTER TABLE templates ADD COLUMN send_time TEXT;`);
    } catch (_) {}

    db.execute(`
      CREATE TABLE IF NOT EXISTS contacts (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        phone_number TEXT NOT NULL,
        expiry_date TEXT NOT NULL
      );
    `);

    // ── expiry_datetime migration (UTC ISO TEXT) ──────────────────────────
    try {
      db.execute(`ALTER TABLE contacts ADD COLUMN expiry_datetime TEXT;`);
    } catch (_) {}

    try {
      db.execute(`
        UPDATE contacts
        SET expiry_datetime = expiry_date || 'T00:00:00Z'
        WHERE expiry_datetime IS NULL AND expiry_date IS NOT NULL;
      `);
    } catch (error) {
      console.log('expiry_datetime backfill error:', error);
    }

    try {
      db.execute(`
        CREATE INDEX IF NOT EXISTS idx_contacts_expiry_datetime
        ON contacts(expiry_datetime);
      `);
    } catch (error) {
      console.log('expiry_datetime index error:', error);
    }
    // ────────────────────────────────────────────────────────────────────

    db.execute(`
      CREATE TABLE IF NOT EXISTS platforms (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        icon TEXT NOT NULL,
        url_scheme TEXT NOT NULL
      );
    `);

    db.execute(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT
      );
    `);

    db.execute(`
      CREATE TABLE IF NOT EXISTS message_queue (
        id TEXT PRIMARY KEY,
        contact_id TEXT NOT NULL,
        template_id TEXT NOT NULL,
        platform_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'PENDING',
        error_reason TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now')),
        sent_at TEXT
      );
    `);

    // ── scheduled_alarms — Layer 2 (Scheduler) source of truth ─────────────
    // AlarmManager is just the executor; this table is what the app
    // actually trusts when deciding whether an alarm is still valid,
    // already fired, or was cancelled. id = `${contact_id}_${template_id}`
    // guarantees idempotency — scheduling the same pair twice just updates
    // the existing row instead of creating a duplicate.
    db.execute(`
      CREATE TABLE IF NOT EXISTS scheduled_alarms (
        id TEXT PRIMARY KEY,
        contact_id TEXT NOT NULL,
        template_id TEXT NOT NULL,
        request_code INTEGER NOT NULL,
        trigger_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'scheduled',
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        UNIQUE(contact_id, template_id)
      );
    `);

    try {
      db.execute(`
        CREATE INDEX IF NOT EXISTS idx_scheduled_alarms_status
        ON scheduled_alarms(status);
      `);
    } catch (error) {
      console.log('scheduled_alarms status index error:', error);
    }

    try {
      db.execute(`
        CREATE INDEX IF NOT EXISTS idx_scheduled_alarms_contact
        ON scheduled_alarms(contact_id);
      `);
    } catch (error) {
      console.log('scheduled_alarms contact index error:', error);
    }

    try {
      db.execute(`
        CREATE INDEX IF NOT EXISTS idx_scheduled_alarms_template
        ON scheduled_alarms(template_id);
      `);
    } catch (error) {
      console.log('scheduled_alarms template index error:', error);
    }
    // ────────────────────────────────────────────────────────────────────

    return db;
  } catch (error) {
    console.log('DB Error:', error);
    return null;
  }
};
