import { getDB } from './db';
import { handleError } from '../utils/errorHandler';

/**
 * Local mirror of Meta's WhatsApp template list. Meta templates only exist
 * on Meta's servers (WhatsAppTemplatesScreen fetches them live) — this table
 * lets other screens (Templates pill badge/sort) show a count without an
 * extra API hit. It's only as fresh as the last time the WhatsApp tab was
 * opened and fetched successfully; that's an acceptable tradeoff for a
 * count badge, not for anything that needs to be authoritative.
 */

// Replaces the entire cache with the latest fetch result — templates that
// were deleted/renamed on Meta's side won't linger here as stale rows.
export const syncWhatsAppTemplatesCache = (metaTemplates) => {
  try {
    const db = getDB();
    db.execute('DELETE FROM whatsapp_templates_cache;');

    (metaTemplates ?? []).forEach((t) => {
      // Meta's raw template object has no flat `.body` — the actual text
      // (with {{1}}, {{2}} placeholders) lives inside components[] on the
      // entry whose type is 'BODY'.
      const bodyComponent = t.components?.find((c) => c.type === 'BODY');
      db.execute(
        `INSERT OR REPLACE INTO whatsapp_templates_cache
         (name, category, language, status, body, synced_at)
         VALUES (?, ?, ?, ?, ?, datetime('now'));`,
        [t.name, t.category ?? null, t.language ?? null, t.status ?? null, bodyComponent?.text ?? null]
      );
    });
    return true;
  } catch (error) {
    handleError(error, 'syncWhatsAppTemplatesCache');
    return false;
  }
};

export const getCachedWhatsAppTemplates = () => {
  try {
    const db = getDB();
    const result = db.execute('SELECT * FROM whatsapp_templates_cache ORDER BY name ASC;');
    return result.rows?._array || [];
  } catch (error) {
    handleError(error, 'getCachedWhatsAppTemplates');
    return [];
  }
};

// Only APPROVED templates are usable for scheduling — Meta rejects sends
// using PENDING/REJECTED template names.
export const getCachedApprovedWhatsAppTemplates = () => {
  try {
    const db = getDB();
    const result = db.execute(
      "SELECT * FROM whatsapp_templates_cache WHERE status = 'APPROVED' ORDER BY name ASC;"
    );
    return result.rows?._array || [];
  } catch (error) {
    handleError(error, 'getCachedApprovedWhatsAppTemplates');
    return [];
  }
};

export const getCachedWhatsAppTemplateCount = () => {
  try {
    const db = getDB();
    const result = db.execute('SELECT COUNT(*) as count FROM whatsapp_templates_cache;');
    return result.rows?._array?.[0]?.count ?? 0;
  } catch (error) {
    handleError(error, 'getCachedWhatsAppTemplateCount');
    return 0;
  }
};