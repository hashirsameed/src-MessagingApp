import { open } from 'react-native-quick-sqlite';
import { SEED_CONTACTS } from './seedContacts';

let db = null;

export const getDB = () => {
  if (db) return db;
  try {
    // 1. Open Database
    db = open({ name: 'MessagingApp.db' });
    
    // 2. PHASE 0 SAFETY NET: Enforce foreign key constraints on every connection
    db.execute('PRAGMA foreign_keys = ON;');
    
    // 3. Build the final Layer B schema directly (No migrations)
    ensureSchema(db);
    
    // 4. Seed QA data in development
    if (__DEV__) seedQaContacts(db);

    return db;
  } catch (error) {
    console.log('[db.js] DB Initialization Error:', error);
    return null;
  }
};

// -----------------------------------------------------------------------------
// LAYER B CONSOLIDATED SCHEMA (Fresh Install / Hard Reset)
// -----------------------------------------------------------------------------
const ensureSchema = (db) => {
  // 1. contacts
  db.execute(`CREATE TABLE IF NOT EXISTS contacts (
    id TEXT PRIMARY KEY, 
    name TEXT NOT NULL, 
    phone_number TEXT NOT NULL,
    expiry_datetime TEXT NOT NULL,
    created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')), 
    updated_at TEXT
  );`);
  db.execute(`CREATE INDEX IF NOT EXISTS idx_contacts_expiry ON contacts(expiry_datetime);`);

  // 2. platforms
  db.execute(`CREATE TABLE IF NOT EXISTS platforms (
    id TEXT PRIMARY KEY, 
    name TEXT NOT NULL, 
    icon TEXT NOT NULL, 
    url_scheme TEXT NOT NULL,
    platform_type TEXT CHECK(platform_type IN ('local_text','managed_remote')) NOT NULL DEFAULT 'local_text',
    is_enabled INTEGER NOT NULL CHECK(is_enabled IN (0,1)) DEFAULT 1,
    created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
  );`);
  db.execute(`INSERT OR IGNORE INTO platforms (id,name,icon,url_scheme,platform_type) VALUES ('sms','SMS','💬','sms:{phone}?body={message}','local_text');`);
  db.execute(`INSERT OR IGNORE INTO platforms (id,name,icon,url_scheme,platform_type) VALUES ('whatsapp','WhatsApp','🟢','','managed_remote');`);

  // 3. platform_rate_limits (Independent module)
  db.execute(`CREATE TABLE IF NOT EXISTS platform_rate_limits (
    platform_id TEXT NOT NULL PRIMARY KEY REFERENCES platforms(id) ON DELETE CASCADE,
    limit_count INTEGER NOT NULL, 
    window_minutes INTEGER NOT NULL
  );`);

  // 4. templates
  db.execute(`CREATE TABLE IF NOT EXISTS templates (
    id TEXT PRIMARY KEY, 
    title TEXT NOT NULL, 
    body TEXT NOT NULL,
    days_before INTEGER NOT NULL DEFAULT 1, 
    send_time TEXT,
    platform_id TEXT NOT NULL REFERENCES platforms(id) ON DELETE RESTRICT,
    meta_template_name TEXT, 
    meta_template_language TEXT,
    is_active INTEGER NOT NULL CHECK(is_active IN (0,1)) DEFAULT 1,
    created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
  );`);

  // 5. whatsapp_templates_cache
  db.execute(`CREATE TABLE IF NOT EXISTS whatsapp_templates_cache (
    name TEXT PRIMARY KEY, 
    category TEXT, 
    language TEXT, 
    status TEXT, 
    body TEXT,
    synced_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
  );`);

  // 6. message_queue (Layer B Core: The source of truth for scheduling)
  db.execute(`CREATE TABLE IF NOT EXISTS message_queue (
    id TEXT PRIMARY KEY,
    contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    template_id TEXT NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
    platform_id TEXT NOT NULL REFERENCES platforms(id) ON DELETE RESTRICT,
    status TEXT CHECK(status IN ('PENDING','CLAIMED','SENT','FAILED','SUPERSEDED')) NOT NULL DEFAULT 'PENDING',
    error_reason TEXT, 
    attempt_count INTEGER NOT NULL DEFAULT 0, 
    claimed_by TEXT,
    scheduled_for TEXT NOT NULL,
    created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')), 
    sent_at TEXT
  );`);
  
  // Layer B Locked Decision: Atomic deduplication strictly on active statuses
  db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_queue_active_pair ON message_queue(contact_id, template_id) WHERE status IN ('PENDING','CLAIMED');`);
  db.execute(`CREATE INDEX IF NOT EXISTS idx_queue_delta_processing ON message_queue(status, scheduled_for);`);

  // 7. scheduled_alarms (Layer B Core: 1:1 linkage via queue_id)
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

  // 8. db_action_log (Audit Logging System preserved from Layer A)
  db.execute(`CREATE TABLE IF NOT EXISTS db_action_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, 
    table_name TEXT NOT NULL, 
    row_id TEXT NOT NULL,
    action TEXT NOT NULL, 
    old_value TEXT, 
    new_value TEXT,
    occurred_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
  );`);
  db.execute(`CREATE INDEX IF NOT EXISTS idx_db_action_log_row ON db_action_log(table_name, row_id);`);
  
  // 9. settings (Optional, kept for future app-level configurations)
  db.execute(`CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY, 
    value TEXT,
    updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
  );`);

  // FIX 7 — SafetyNetTask distributed lock seed
  // Ye row SafetyNetTask ke concurrent runs rokne ke liye use hoti hai.
  // INSERT OR IGNORE: fresh install par banegi, existing installs par kuch nahi karti.
  db.execute(`INSERT OR IGNORE INTO settings (key, value) VALUES ('safetynet_lock', NULL);`);
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