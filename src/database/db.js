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

    return db;
  } catch (error) {
    console.log('DB Error:', error);
    return null;
  }
};