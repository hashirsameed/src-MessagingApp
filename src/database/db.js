import { open } from 'react-native-quick-sqlite';
import { SEED_CONTACTS } from './seedContacts';

let db = null;

const SCHEMA_VERSION = 3;

export const getDB = () => {
  if (db) return db;
  try {
    db = open({ name: 'MessagingApp.db' });
    db.execute('PRAGMA foreign_keys = ON;');
    db.execute(`CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY, value TEXT,
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );`);

    const version = getSchemaVersion(db);
    if (version === 1) migrateToV2(db);
    // v3 (SUPERSEDED status support) applies on top of either a
    // just-migrated-from-v1 db or an already-v2 db. Fresh installs
    // (version === 0) skip this entirely — ensureSchema() below already
    // creates message_queue with SUPERSEDED in its CHECK from the start.
    if (version === 1 || version === 2) migrateToV3(db);
    ensureSchema(db);
    if (version === 0) setSchemaVersion(db, SCHEMA_VERSION);
    // QA/test contacts must never ship in a production build — __DEV__ is
    // the same flag ContactListScreen.js already uses to hide its Test
    // panel and "Check Expiring" button, so this stays consistent with
    // how the rest of the app already draws the dev-vs-prod line.
    if (__DEV__) seedQaContacts(db);

    return db;
  } catch (error) {
    console.log('DB Error:', error);
    return null;
  }
};

const getSchemaVersion = (db) => {
  try {
    const row = db.execute("SELECT value FROM settings WHERE key='schema_version';").rows?._array?.[0];
    if (row?.value) return parseInt(row.value, 10);
    const hasContacts = db.execute(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='contacts';",
    ).rows?._array?.[0];
    return hasContacts ? 1 : 0;
  } catch {
    return 0;
  }
};

const setSchemaVersion = (db, version) => db.execute(
  `INSERT INTO settings (key, value, updated_at) VALUES ('schema_version', ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
   ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at;`,
  [String(version)],
);

const migrateToV2 = (db) => {
  try {
    db.transaction((tx) => {
      try { tx.execute(`ALTER TABLE contacts ADD COLUMN updated_at TEXT;`); } catch {}
      try { tx.execute(`ALTER TABLE platforms ADD COLUMN created_at TEXT;`); } catch {}

      tx.execute(`CREATE TABLE IF NOT EXISTS message_queue_new (
        id TEXT PRIMARY KEY,
        contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
        template_id TEXT NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
        platform_id TEXT NOT NULL REFERENCES platforms(id) ON DELETE RESTRICT,
        status TEXT CHECK(status IN ('PENDING','CLAIMED','SENT','FAILED')) NOT NULL DEFAULT 'PENDING',
        error_reason TEXT, attempt_count INTEGER NOT NULL DEFAULT 0, claimed_by TEXT,
        scheduled_for TEXT NOT NULL,
        created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')), sent_at TEXT
      );`);
      tx.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_queue_active_pair ON message_queue_new(contact_id, template_id) WHERE status IN ('PENDING','CLAIMED');`);
      tx.execute(`CREATE INDEX IF NOT EXISTS idx_queue_delta_processing ON message_queue_new(status, scheduled_for);`);

      tx.execute(`CREATE TABLE IF NOT EXISTS scheduled_alarms_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        queue_id TEXT NOT NULL UNIQUE REFERENCES message_queue_new(id) ON DELETE CASCADE,
        request_code INTEGER NOT NULL UNIQUE,
        trigger_at TEXT NOT NULL,
        status TEXT CHECK(status IN ('scheduled','firing','fired','cancelled')) NOT NULL DEFAULT 'scheduled',
        created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
        updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
      );`);
      tx.execute(`CREATE INDEX IF NOT EXISTS idx_alarms_lookup ON scheduled_alarms_new(status, trigger_at);`);

      const oldAlarms = tx.execute(`SELECT * FROM scheduled_alarms;`).rows?._array || [];

      // DSA: Set-based O(1) collision check | Complexity: O(n) total for n old rows
      const usedCodes = new Set(oldAlarms.map((r) => r.request_code).filter((c) => c != null));
      let fallback = 900000000;
      const safeCode = (candidate) => {
        if (candidate != null && !usedCodes.has(candidate)) return usedCodes.add(candidate), candidate;
        while (usedCodes.has(fallback)) fallback++;
        return usedCodes.add(fallback), fallback++;
      };

      const linkedOldQueueIds = new Set();

      for (const row of oldAlarms) {
        if (row.status === 'cancelled') continue;

        const queueMatch = tx.execute(
          `SELECT * FROM message_queue WHERE contact_id=? AND template_id=? ORDER BY created_at DESC LIMIT 1;`,
          [row.contact_id, row.template_id],
        ).rows?._array?.[0];
        if (queueMatch) linkedOldQueueIds.add(queueMatch.id);

        const newQueueId = `migrated_${row.id}`;
        const queueStatus = ['scheduled', 'firing'].includes(row.status) ? 'PENDING' : (queueMatch?.status || 'SENT');

        tx.execute(
          `INSERT OR IGNORE INTO message_queue_new
            (id, contact_id, template_id, platform_id, status, error_reason, attempt_count, claimed_by, scheduled_for, created_at, sent_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?);`,
          [newQueueId, row.contact_id, row.template_id, queueMatch?.platform_id || 'sms', queueStatus,
            queueMatch?.error_reason || null, queueMatch?.attempt_count || 0, null, row.trigger_at,
            queueMatch?.created_at || row.created_at, queueMatch?.sent_at || null],
        );

        tx.execute(
          `INSERT OR IGNORE INTO scheduled_alarms_new (queue_id, request_code, trigger_at, status, created_at, updated_at)
           VALUES (?,?,?,?,?,?);`,
          [newQueueId, safeCode(row.request_code), row.trigger_at, row.status === 'firing' ? 'scheduled' : row.status, row.created_at, row.updated_at],
        );
      }

      const oldQueueRows = tx.execute(`SELECT * FROM message_queue;`).rows?._array || [];
      for (const row of oldQueueRows) {
        if (linkedOldQueueIds.has(row.id)) continue;
        if (row.status !== 'SENT' && row.status !== 'FAILED') continue;
        tx.execute(
          `INSERT OR IGNORE INTO message_queue_new
            (id, contact_id, template_id, platform_id, status, error_reason, attempt_count, claimed_by, scheduled_for, created_at, sent_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?);`,
          [`legacy_${row.id}`, row.contact_id, row.template_id, row.platform_id, row.status,
            row.error_reason, row.attempt_count, null, row.created_at, row.created_at, row.sent_at],
        );
      }

      tx.execute(`DROP TABLE message_queue;`);
      tx.execute(`ALTER TABLE message_queue_new RENAME TO message_queue;`);
      tx.execute(`DROP TABLE scheduled_alarms;`);
      tx.execute(`ALTER TABLE scheduled_alarms_new RENAME TO scheduled_alarms;`);
      tx.execute(
        `INSERT INTO settings (key, value, updated_at) VALUES ('schema_version','2',strftime('%Y-%m-%dT%H:%M:%SZ','now'))
         ON CONFLICT(key) DO UPDATE SET value='2', updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now');`,
      );
    });
  } catch (error) {
    console.log('[db.js] v2 migration failed, old schema remains active:', error);
  }
};

/**
 * migrateToV3 — adds 'SUPERSEDED' to message_queue.status's allowed
 * values. SQLite can't ALTER a CHECK constraint in place, so this rebuilds
 * the table the same way migrateToV2 rebuilt message_queue/scheduled_alarms:
 * create a new table with the wider CHECK, copy every row across
 * unchanged, drop the old table, rename.
 *
 * 'SUPERSEDED' is used instead of deleting a CLAIMED row outright when a
 * contact's expiry is edited while a send for that pair is already
 * in-flight (see upsertScheduledAlarm in scheduledAlarmDB.js) — deleting
 * it would make the in-flight send's eventual markAsSent()/markAsFailed()
 * silently no-op against a row that no longer exists.
 *
 * No FK issue dropping message_queue here even though scheduled_alarms.
 * queue_id references it: DROP TABLE does not fire ON DELETE CASCADE
 * (that only triggers on actual DELETE statements against rows), and the
 * new table is renamed back to the same name with the same id values
 * intact, so scheduled_alarms' FK stays valid once the transaction ends.
 */
const migrateToV3 = (db) => {
  try {
    const hasQueueTable = db.execute(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='message_queue';",
    ).rows?._array?.[0];
    if (!hasQueueTable) return; // nothing to migrate yet — ensureSchema creates the v3 shape directly

    db.transaction((tx) => {
      tx.execute(`CREATE TABLE IF NOT EXISTS message_queue_v3 (
        id TEXT PRIMARY KEY,
        contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
        template_id TEXT NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
        platform_id TEXT NOT NULL REFERENCES platforms(id) ON DELETE RESTRICT,
        status TEXT CHECK(status IN ('PENDING','CLAIMED','SENT','FAILED','SUPERSEDED')) NOT NULL DEFAULT 'PENDING',
        error_reason TEXT, attempt_count INTEGER NOT NULL DEFAULT 0, claimed_by TEXT,
        scheduled_for TEXT NOT NULL,
        created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')), sent_at TEXT
      );`);

      tx.execute(`INSERT INTO message_queue_v3
        (id, contact_id, template_id, platform_id, status, error_reason, attempt_count, claimed_by, scheduled_for, created_at, sent_at)
        SELECT id, contact_id, template_id, platform_id, status, error_reason, attempt_count, claimed_by, scheduled_for, created_at, sent_at
        FROM message_queue;`);

      tx.execute(`DROP TABLE message_queue;`);
      tx.execute(`ALTER TABLE message_queue_v3 RENAME TO message_queue;`);

      tx.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_queue_active_pair ON message_queue(contact_id, template_id) WHERE status IN ('PENDING','CLAIMED');`);
      tx.execute(`CREATE INDEX IF NOT EXISTS idx_queue_delta_processing ON message_queue(status, scheduled_for);`);

      tx.execute(
        `INSERT INTO settings (key, value, updated_at) VALUES ('schema_version','3',strftime('%Y-%m-%dT%H:%M:%SZ','now'))
         ON CONFLICT(key) DO UPDATE SET value='3', updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now');`,
      );
    });
  } catch (error) {
    console.log('[db.js] v3 migration failed, old schema remains active:', error);
  }
};

const ensureSchema = (db) => {
  db.execute(`CREATE TABLE IF NOT EXISTS contacts (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, phone_number TEXT NOT NULL,
    expiry_datetime TEXT NOT NULL,
    created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')), updated_at TEXT
  );`);
  db.execute(`CREATE INDEX IF NOT EXISTS idx_contacts_expiry ON contacts(expiry_datetime);`);

  db.execute(`CREATE TABLE IF NOT EXISTS platforms (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, icon TEXT NOT NULL, url_scheme TEXT NOT NULL,
    platform_type TEXT CHECK(platform_type IN ('local_text','managed_remote')) NOT NULL DEFAULT 'local_text',
    is_enabled INTEGER NOT NULL CHECK(is_enabled IN (0,1)) DEFAULT 1,
    created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
  );`);
  db.execute(`INSERT OR IGNORE INTO platforms (id,name,icon,url_scheme,platform_type) VALUES ('sms','SMS','💬','sms:{phone}?body={message}','local_text');`);
  db.execute(`INSERT OR IGNORE INTO platforms (id,name,icon,url_scheme,platform_type) VALUES ('whatsapp','WhatsApp','🟢','','managed_remote');`);

  db.execute(`CREATE TABLE IF NOT EXISTS platform_rate_limits (
    platform_id TEXT NOT NULL PRIMARY KEY REFERENCES platforms(id) ON DELETE CASCADE,
    limit_count INTEGER NOT NULL, window_minutes INTEGER NOT NULL
  );`);

  db.execute(`CREATE TABLE IF NOT EXISTS templates (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL,
    days_before INTEGER NOT NULL DEFAULT 1, send_time TEXT,
    platform_id TEXT NOT NULL REFERENCES platforms(id) ON DELETE RESTRICT,
    meta_template_name TEXT, meta_template_language TEXT,
    is_active INTEGER NOT NULL CHECK(is_active IN (0,1)) DEFAULT 1,
    created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
  );`);

  db.execute(`CREATE TABLE IF NOT EXISTS whatsapp_templates_cache (
    name TEXT PRIMARY KEY, category TEXT, language TEXT, status TEXT, body TEXT,
    synced_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
  );`);

  db.execute(`CREATE TABLE IF NOT EXISTS message_queue (
    id TEXT PRIMARY KEY,
    contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    template_id TEXT NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
    platform_id TEXT NOT NULL REFERENCES platforms(id) ON DELETE RESTRICT,
    status TEXT CHECK(status IN ('PENDING','CLAIMED','SENT','FAILED','SUPERSEDED')) NOT NULL DEFAULT 'PENDING',
    error_reason TEXT, attempt_count INTEGER NOT NULL DEFAULT 0, claimed_by TEXT,
    scheduled_for TEXT NOT NULL,
    created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')), sent_at TEXT
  );`);
  // DSA: partial index (filtered B-tree) | Complexity: O(log n) dup-check, zero cost on historical rows
  db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_queue_active_pair ON message_queue(contact_id, template_id) WHERE status IN ('PENDING','CLAIMED');`);
  db.execute(`CREATE INDEX IF NOT EXISTS idx_queue_delta_processing ON message_queue(status, scheduled_for);`);

  db.execute(`CREATE TABLE IF NOT EXISTS scheduled_alarms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    queue_id TEXT NOT NULL UNIQUE REFERENCES message_queue(id) ON DELETE CASCADE,
    request_code INTEGER NOT NULL UNIQUE,
    trigger_at TEXT NOT NULL,
    status TEXT CHECK(status IN ('scheduled','firing','fired','cancelled')) NOT NULL DEFAULT 'scheduled',
    created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
  );`);
  db.execute(`CREATE INDEX IF NOT EXISTS idx_alarms_lookup ON scheduled_alarms(status, trigger_at);`);

  db.execute(`CREATE TABLE IF NOT EXISTS db_action_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, table_name TEXT NOT NULL, row_id TEXT NOT NULL,
    action TEXT NOT NULL, old_value TEXT, new_value TEXT,
    occurred_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
  );`);
  db.execute(`CREATE INDEX IF NOT EXISTS idx_db_action_log_row ON db_action_log(table_name, row_id);`);
};

const seedQaContacts = (db) => {
  for (const [id, name, phone, expiry] of SEED_CONTACTS) {
    db.execute(
      `INSERT OR IGNORE INTO contacts (id, name, phone_number, expiry_datetime, created_at)
       VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'));`,
      [id, name, phone, expiry],
    );
  }
};