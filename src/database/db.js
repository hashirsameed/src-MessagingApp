import { open } from 'react-native-quick-sqlite';
import { SEED_CONTACTS } from './seedContacts';

let db = null;
// TEST-ONLY — resets just this module's cached connection reference so a
// test can simulate "app process restarted" (a fresh getDB() call re-runs
// ensureSchema()/seed) WITHOUT touching the underlying SQLite storage —
// on a real device the DB file survives a restart; only this in-memory JS
// reference doesn't. Never called from any production code path.
export const __resetDbSingletonForTests = () => { db = null; };

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
    platform_type TEXT CHECK(platform_type IN ('local_text','managed_remote','bulk_remote')) NOT NULL DEFAULT 'local_text',
    is_enabled INTEGER NOT NULL CHECK(is_enabled IN (0,1)) DEFAULT 1,
    created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
  );`);
  db.execute(`INSERT OR IGNORE INTO platforms (id,name,icon,url_scheme,platform_type) VALUES ('sms','SMS','💬','sms:{phone}?body={message}','local_text');`);
  db.execute(`INSERT OR IGNORE INTO platforms (id,name,icon,url_scheme,platform_type) VALUES ('whatsapp','WhatsApp','🟢','','managed_remote');`);
  // Bulk SMS API — separate platform from device 'sms' (see bulkSmsAdapter.js).
  // Seeded DISABLED so it never appears as a usable send target until the
  // user actually connects a provider from Settings — same convention as
  // WhatsApp requiring configuration first, just enforced via is_enabled
  // here since bulk SMS has no fixed provider to check credentials against
  // at seed time.
  db.execute(`INSERT OR IGNORE INTO platforms (id,name,icon,url_scheme,platform_type,is_enabled) VALUES ('sms_bulk','Bulk SMS','📨','','bulk_remote',0);`);

  // 3. platform_rate_limits — single CUSTOM OVERRIDE tier per platform.
  // When a row exists here for a platform, it REPLACES the default tiers
  // in platform_rate_limit_tiers entirely (this is the bulk-SMS-API path,
  // or any platform where the user wants one specific number instead of
  // the default three-tier scheme).
  db.execute(`CREATE TABLE IF NOT EXISTS platform_rate_limits (
    platform_id TEXT NOT NULL PRIMARY KEY REFERENCES platforms(id) ON DELETE CASCADE,
    limit_count INTEGER NOT NULL, 
    window_minutes INTEGER NOT NULL
  );`);

  // 3b. platform_rate_limit_tiers — DEFAULT, DB-DRIVEN, EDITABLE tiers.
  // A platform can have multiple simultaneous tiers (e.g. SMS: 150/15min,
  // 250/1hr, 750/24hr — ALL must hold at once, AND logic, strictly under
  // each limit). Seeded below with INSERT OR IGNORE so it's a starting
  // value only — fully editable afterwards from Settings, never
  // hardcoded/read back into code.
  db.execute(`CREATE TABLE IF NOT EXISTS platform_rate_limit_tiers (
    platform_id TEXT NOT NULL REFERENCES platforms(id) ON DELETE CASCADE,
    window_minutes INTEGER NOT NULL,
    limit_count INTEGER NOT NULL,
    PRIMARY KEY (platform_id, window_minutes)
  );`);
  db.execute(`INSERT OR IGNORE INTO platform_rate_limit_tiers (platform_id, window_minutes, limit_count) VALUES ('sms', 15, 150);`);
  db.execute(`INSERT OR IGNORE INTO platform_rate_limit_tiers (platform_id, window_minutes, limit_count) VALUES ('sms', 60, 250);`);
  db.execute(`INSERT OR IGNORE INTO platform_rate_limit_tiers (platform_id, window_minutes, limit_count) VALUES ('sms', 1440, 750);`);

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
  db.execute(`CREATE INDEX IF NOT EXISTS idx_queue_status_sent ON message_queue(status, sent_at);`);

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