import { open } from 'react-native-quick-sqlite';

let db = null;

const SCHEMA_VERSION = 2;

export const getDB = () => {
  if (db) return db;
  try {
    db = open({ name: 'MessagingApp.db' });
    db.execute('PRAGMA foreign_keys = ON;');
    db.execute(`CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY, value TEXT,
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );`);

<<<<<<< HEAD
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

    // ── platform_id migration — per-template platform selection (Step 6a) ──
    // NULL/unset means "use the global default platform" (settings) —
    // fully backward-compatible with every template created before this.
    try {
      db.execute(`ALTER TABLE templates ADD COLUMN platform_id TEXT;`);
    } catch (_) {}

    // ── WhatsApp scheduling linkage — a WhatsApp-platform template row
    // doesn't send its own `body` as freeform text (Meta rejects that
    // outside a live 24h session); it points at one specific APPROVED Meta
    // template by name+language instead. NULL for every non-WhatsApp row.
    try {
      db.execute(`ALTER TABLE templates ADD COLUMN meta_template_name TEXT;`);
    } catch (_) {}
    try {
      db.execute(`ALTER TABLE templates ADD COLUMN meta_template_language TEXT;`);
    } catch (_) {}

    try {
      db.execute(`
        UPDATE templates
        SET platform_id = 'sms'
        WHERE platform_id IS NULL;
      `);
    } catch (error) {
      console.log('templates.platform_id backfill error:', error);
    }
    // ────────────────────────────────────────────────────────────────────

    db.execute(`
      CREATE TABLE IF NOT EXISTS contacts (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        phone_number TEXT NOT NULL,
        expiry_date TEXT NOT NULL
      );
    `);

    // ── created_at migration ──────────────────────────────────────────────
    // Records when each contact actually entered the system. Used by
    // alarmScheduler to tell "this template's exact time passed before the
    // contact existed" (must be skipped) apart from "this template's time
    // passed while the contact already existed but the device was asleep/
    // closed" (must still catch up). Without this column both cases look
    // identical — both are simply "in the past" — which is the root cause
    // of a same-day-added contact instantly firing an earlier template
    // whose clock time has already gone by.
    try {
      db.execute(`ALTER TABLE contacts ADD COLUMN created_at TEXT;`);
    } catch (_) {}

    // Backfill existing rows to a far-past timestamp (NOT "now"). These
    // contacts were already in the system before this column existed, so
    // we must preserve their existing "any overdue template is still
    // eligible" behavior instead of retroactively blocking their pending
    // catch-up alarms.
    try {
      db.execute(`
        UPDATE contacts
        SET created_at = '1970-01-01T00:00:00Z'
        WHERE created_at IS NULL;
      `);
    } catch (error) {
      console.log('contacts.created_at backfill error:', error);
    }
    // ────────────────────────────────────────────────────────────────────

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

    // ── QA test contacts seed (fixed IDs) ─────────────────────────────────
    // 5 real hardcoded contacts for manual on-device testing. INSERT OR
    // IGNORE keyed on fixed ids means: already present (same build, app
    // just reopened) → no-op; row missing (fresh install, or uninstall +
    // reinstall wiped the DB file) → recreated automatically. Never
    // overwrites an existing row, so anything a tester changes via the
    // Test panel (expiry_date/expiry_datetime) survives normal app restarts.
    //
    // ⚠️ These are real phone numbers. The Scan/Update Time test actions run
    // the REAL send path (SafetyNetTask → fireScheduledPair → actual SMS
    // intent) — every Scan will text these numbers for real.
    try {
      const testContacts = [
        { id: 'seed_test_contact_01', name: 'Hashir',        phone_number: '', expiry_datetime: '2026-07-18T09:00:00Z' },
        { id: 'seed_test_contact_02', name: 'Hashir Sameed', phone_number: '', expiry_datetime: '2026-07-25T09:00:00Z' },
        { id: 'seed_test_contact_03', name: 'Auon Bhai',     phone_number: '', expiry_datetime: '2026-08-30T09:00:00Z' },
        { id: 'seed_test_contact_04', name: 'Ayesha',        phone_number: '', expiry_datetime: '2026-08-18T09:00:00Z' },
        { id: 'seed_test_contact_05', name: 'Hussain',       phone_number: '', expiry_datetime: '2026-06-18T09:00:00Z' },
      ];

      for (const c of testContacts) {
        db.execute(
          `INSERT OR IGNORE INTO contacts (id, name, phone_number, expiry_date, expiry_datetime, created_at)
           VALUES (?, ?, ?, ?, ?, datetime('now'));`,
          [c.id, c.name, c.phone_number, c.expiry_datetime.slice(0, 10), c.expiry_datetime],
        );
      }
    } catch (error) {
      console.log('QA test contacts seed error:', error);
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

    // ── platform_type migration — registry-pattern dispatch (Step 1) ──────
    // 'local_text'     → SMS, Email, Gmail, any custom Linking/url_scheme platform
    // 'managed_remote' → WhatsApp (Meta Cloud API, approved templates)
    try {
      db.execute(`ALTER TABLE platforms ADD COLUMN platform_type TEXT NOT NULL DEFAULT 'local_text';`);
    } catch (_) {}

    try {
      db.execute(`
        UPDATE platforms
        SET platform_type = 'managed_remote'
        WHERE id = 'whatsapp' AND platform_type != 'managed_remote';
      `);
    } catch (error) {
      console.log('platform_type backfill error:', error);
    }

    // 'sms' + 'whatsapp' are built-in and referenced by id in queueProcessor/
    // schedulerEngine, but they don't live in the platforms table by default
    // (only custom platforms + seeded Email/Gmail do — see platformDB.js).
    // Seed both built-ins here so getAllPlatforms() becomes the single source
    // of truth for tab rendering (Step 6) without touching dispatch (Step 5).
    try {
      db.execute(`
        INSERT OR IGNORE INTO platforms (id, name, icon, url_scheme, platform_type)
        VALUES ('sms', 'SMS', '💬', 'sms:{phone}?body={message}', 'local_text');
      `);
      db.execute(`
        INSERT OR IGNORE INTO platforms (id, name, icon, url_scheme, platform_type)
        VALUES ('whatsapp', 'WhatsApp', '🟢', '', 'managed_remote');
      `);
    } catch (error) {
      console.log('built-in platform seed error:', error);
    }
    // ────────────────────────────────────────────────────────────────────

    // ── platform enable/disable toggle (Settings screen) ──────────────────
    // 1 = active (shows as tab, sends reminders), 0 = paused (hidden, alarms
    // cancelled but scheduled_alarms rows kept for history/re-enable).
    try {
      db.execute(`ALTER TABLE platforms ADD COLUMN is_enabled INTEGER NOT NULL DEFAULT 1;`);
    } catch (_) {}
    // ────────────────────────────────────────────────────────────────────

    // ── WhatsApp (Meta) templates cache — local mirror ─────────────────────
    // Meta template list only lives on Meta's servers; every screen that
    // needs a WhatsApp template count (Templates pill badge, sorting) would
    // otherwise need its own live API hit. Instead, whenever the WhatsApp
    // tab actually fetches from Meta, it also upserts here — everyone else
    // just reads this local cache. "Freshness" = whenever the WhatsApp tab
    // was last opened, which is good enough for a count badge.
    db.execute(`
      CREATE TABLE IF NOT EXISTS whatsapp_templates_cache (
        name TEXT PRIMARY KEY,
        category TEXT,
        language TEXT,
        status TEXT,
        body TEXT,
        synced_at TEXT DEFAULT (datetime('now'))
      );
    `);
    // ────────────────────────────────────────────────────────────────────

    db.execute(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT
      );
    `);

    // ── per-platform rate limits — configurable count + custom time window ─
    // Replaces the old hardcoded "SMS per hour" setting. No row for a
    // platform = unlimited (matches old behavior for every non-SMS
    // platform, which was never throttled before this).
    db.execute(`
      CREATE TABLE IF NOT EXISTS platform_rate_limits (
        platform_id TEXT NOT NULL PRIMARY KEY,
        limit_count INTEGER NOT NULL,
        window_minutes INTEGER NOT NULL
      );
    `);

    // One-time carry-over: anyone who already set the old single
    // "sms_per_hour_limit" setting keeps that exact config instead of
    // silently reverting to a fresh default under the new system.
    try {
      const legacy = db.execute("SELECT value FROM settings WHERE key = 'sms_per_hour_limit';").rows?._array?.[0];
      const existingSmsLimit = db.execute("SELECT 1 FROM platform_rate_limits WHERE platform_id = 'sms';").rows?._array?.[0];
      if (legacy?.value && !existingSmsLimit) {
        db.execute(
          'INSERT INTO platform_rate_limits (platform_id, limit_count, window_minutes) VALUES (?, ?, ?);',
          ['sms', Number(legacy.value), 60],
        );
      }
    } catch (_) {}

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

    // ── claim token — fixes a race that caused double-sends ────────────────
    // Native AlarmManager and the 15-min WorkManager safety net can both
    // fire close together, each running its own processQueue(). The old
    // claimPendingQueue() did SELECT-pending then UPDATE-by-id as two
    // separate steps, so if both runs' SELECTs landed before either UPDATE,
    // both would claim and send the SAME row. The fix conditions the UPDATE
    // on status='PENDING' at write time (not read time) and tags claimed
    // rows with a unique token, so a second concurrent claim can never grab
    // rows the first one already took.
    try {
      db.execute(`ALTER TABLE message_queue ADD COLUMN claimed_by TEXT;`);
    } catch (_) {}

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

    // ── Audit log (db_action_log) ─────────────────────────────────────────
    // Records every insert/update/delete on contacts and scheduled_alarms,
    // independent of the scheduling logic itself — a pure observation
    // layer. Persists across app restarts (unlike debugTrace, which is
    // console.log-only and __DEV__-gated), so "what happened to this
    // contact, and when" can be answered even after the app was closed
    // and reopened, including across a phone reboot.
    db.execute(`
      CREATE TABLE IF NOT EXISTS db_action_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        table_name TEXT NOT NULL,
        row_id TEXT NOT NULL,
        action TEXT NOT NULL,
        old_value TEXT,
        new_value TEXT,
        occurred_at TEXT DEFAULT (datetime('now'))
      );
    `);

    try {
      db.execute(`
        CREATE INDEX IF NOT EXISTS idx_db_action_log_row
        ON db_action_log(table_name, row_id);
      `);
    } catch (error) {
      console.log('db_action_log row index error:', error);
    }
    // ────────────────────────────────────────────────────────────────────
=======
    const version = getSchemaVersion(db);
    if (version === 1) migrateToV2(db);
    ensureSchema(db);
    if (version === 0) setSchemaVersion(db, SCHEMA_VERSION);
    seedQaContacts(db);
>>>>>>> ec38dfc (need to fixed it according to next approach)

    return db;
  } catch (error) {
    console.log('DB Error:', error);
    return null;
  }
};
<<<<<<< HEAD
=======

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
    status TEXT CHECK(status IN ('PENDING','CLAIMED','SENT','FAILED')) NOT NULL DEFAULT 'PENDING',
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
  const contacts = [
    ['seed_test_contact_01', 'Hashir', '', '2026-07-18T09:00:00Z'],
    ['seed_test_contact_02', 'Hashir Sameed', '', '2026-07-25T09:00:00Z'],
    ['seed_test_contact_03', 'Auon Bhai', '', '2026-08-30T09:00:00Z'],
    ['seed_test_contact_04', 'Ayesha', '', '2026-08-18T09:00:00Z'],
    ['seed_test_contact_05', 'Hussain', '', '2026-06-18T09:00:00Z'],
  ];
  for (const [id, name, phone, expiry] of contacts) {
    db.execute(
      `INSERT OR IGNORE INTO contacts (id, name, phone_number, expiry_datetime, created_at)
       VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'));`,
      [id, name, phone, expiry],
    );
  }
};
>>>>>>> ec38dfc (need to fixed it according to next approach)
