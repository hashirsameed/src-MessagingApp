/**
 * Platform adapter registry.
 *
 * Keyed by `platform_type` (see platforms.platform_type column, db.js):
 *   - 'local_text'     → SMS, Email, Gmail, any custom Linking/url_scheme platform
 *   - 'managed_remote' → WhatsApp (Meta Cloud API, approved templates)
 *   - 'bulk_remote'    → Bulk SMS API (generic gateway — see bulkSmsAdapter.js)
 *
 * Each adapter implements the same shape:
 *   {
 *     dispatch(platform, contact, message, ctx) -> Promise<'sent' | 'failed_<REASON>'>
 *     TemplateForm: React component for Create/Edit template UI
 *     TemplateListItem: React component for rendering one row in the tab
 *   }
 *
 * This file stays a dumb lookup table on purpose — no logic here. Steps 3/4
 * fill in the real adapters; queueProcessor (Step 5) and TemplatesScreen
 * (Step 6) will import `getAdapter(platform_type)` instead of branching on
 * platform.id directly.
 */

export const registry = {
  local_text: null,
  managed_remote: null,
  bulk_remote: null,
};

export const registerAdapter = (platformType, adapter) => {
  registry[platformType] = adapter;
};

export const getAdapter = (platformType) => {
  const adapter = registry[platformType];
  if (!adapter) {
    throw new Error(`[platforms/registry] No adapter registered for platform_type "${platformType}"`);
  }
  return adapter;
};