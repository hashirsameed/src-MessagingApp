import { getDB } from './db';
import { handleError } from '../utils/errorHandler';

export const getAllTemplates = () => {
  try {
    const db = getDB();
    const result = db.execute('SELECT * FROM templates ORDER BY created_at DESC;');
    return result.rows?._array || [];
  } catch (error) {
    handleError(error, 'getAllTemplates');
    return [];
  }
};

// Read only one platform page at a time so template-heavy accounts do not
// load the complete table when opening the Templates screen.
export const getTemplatesPage = (platformId, limit, offset) => {
  try {
    const db = getDB();
    const result = db.execute(
      `SELECT * FROM templates
       WHERE platform_id = ?
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?;`,
      [platformId, limit, offset]
    );
    return result.rows?._array || [];
  } catch (error) {
    handleError(error, 'getTemplatesPage');
    return [];
  }
};

// Counts are deliberately separate from page reads: tab badges must show
// totals, not merely the number of rows currently loaded in the FlatList.
export const getTemplateCountsByPlatform = () => {
  try {
    const db = getDB();
    const result = db.execute(
      'SELECT platform_id, COUNT(*) AS count FROM templates GROUP BY platform_id;'
    );
    return (result.rows?._array || []).reduce((counts, row) => {
      counts[row.platform_id ?? 'sms'] = row.count;
      return counts;
    }, {});
  } catch (error) {
    handleError(error, 'getTemplateCountsByPlatform');
    return {};
  }
};

export const getActiveTemplates = () => {
  try {
    const db = getDB();
    const result = db.execute(
      'SELECT * FROM templates WHERE is_active = 1 ORDER BY days_before ASC, send_time ASC;'
    );
    return result.rows?._array || [];
  } catch (error) {
    handleError(error, 'getActiveTemplates');
    return [];
  }
};

export const insertTemplate = (template) => {
  try {
    const db = getDB();
    db.execute(
      `INSERT INTO templates
       (id, title, body, days_before, is_active, send_time, platform_id,
        meta_template_name, meta_template_language)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        template.id,
        template.title,
        template.body,
        template.days_before ?? 1,
        template.is_active ?? 1,
        template.send_time ?? null,
        template.platform_id ?? null,
        template.meta_template_name ?? null,
        template.meta_template_language ?? null,
      ]
    );
    return true;
  } catch (error) {
    handleError(error, 'insertTemplate');
    return false;
  }
};

export const updateTemplate = (template) => {
  try {
    const db = getDB();
    db.execute(
      `UPDATE templates
       SET title = ?, body = ?, days_before = ?, is_active = ?, send_time = ?,
           platform_id = ?, meta_template_name = ?, meta_template_language = ?
       WHERE id = ?;`,
      [
        template.title,
        template.body,
        template.days_before ?? 1,
        template.is_active ?? 1,
        template.send_time ?? null,
        template.platform_id ?? null,
        template.meta_template_name ?? null,
        template.meta_template_language ?? null,
        template.id,
      ]
    );
    return true;
  } catch (error) {
    handleError(error, 'updateTemplate');
    return false;
  }
};

export const toggleTemplateActive = (id, isActive) => {
  try {
    const db = getDB();
    db.execute(
      'UPDATE templates SET is_active = ? WHERE id = ?;',
      [isActive ? 1 : 0, id]
    );
    return true;
  } catch (error) {
    handleError(error, 'toggleTemplateActive');
    return false;
  }
};

export const deleteTemplate = (id) => {
  try {
    const db = getDB();
    db.execute('DELETE FROM templates WHERE id = ?;', [id]);
    return true;
  } catch (error) {
    handleError(error, 'deleteTemplate');
    return false;
  }
};

export const cloneTemplate = (template) => {
  try {
    const db = getDB();
    const cloned = {
      id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      title: template.title + ' (Clone)',
      body: template.body,
      days_before: template.days_before ?? 1,
      is_active: 0, // cloned template starts as inactive
      send_time: template.send_time ?? null,
      platform_id: template.platform_id ?? null,
      meta_template_name: template.meta_template_name ?? null,
      meta_template_language: template.meta_template_language ?? null,
    };
    db.execute(
      `INSERT INTO templates
       (id, title, body, days_before, is_active, send_time, platform_id,
        meta_template_name, meta_template_language)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        cloned.id, cloned.title, cloned.body, cloned.days_before, cloned.is_active,
        cloned.send_time, cloned.platform_id, cloned.meta_template_name, cloned.meta_template_language,
      ]
    );
    return cloned;
  } catch (error) {
    handleError(error, 'cloneTemplate');
    return null;
  }
};
export const getTemplateById = (id) => {
  try {
    const db = getDB();
    const result = db.execute('SELECT * FROM templates WHERE id = ?;', [id]);
    return result.rows?._array?.[0] || null;
  } catch (error) {
    handleError(error, 'getTemplateById');
    return null;
  }
};
