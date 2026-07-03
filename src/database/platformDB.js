import { getDB } from './db';
import { handleError } from '../utils/errorHandler';

export const DEFAULT_PLATFORMS = [
  {
    id: 'default_email',
    name: 'Email',
    icon: '📧',
    url_scheme: 'mailto:{phone}?body={message}',
  },
  {
    id: 'default_gmail',
    name: 'Gmail',
    icon: '✉️',
    url_scheme: 'mailto:{phone}?body={message}',
  },
];

export const getAllPlatforms = () => {
  try {
    const db = getDB();
    const result = db.execute('SELECT * FROM platforms ORDER BY name ASC;');
    return result.rows?._array || [];
  } catch (error) {
    handleError(error, 'getAllPlatforms');
    return [];
  }
};

export const insertPlatform = (platform) => {
  try {
    const db = getDB();
    db.execute(
      'INSERT INTO platforms (id, name, icon, url_scheme) VALUES (?, ?, ?, ?);',
      [platform.id, platform.name, platform.icon, platform.url_scheme]
    );
    return true;
  } catch (error) {
    handleError(error, 'insertPlatform');
    return false;
  }
};

export const deletePlatform = (id) => {
  try {
    const db = getDB();
    db.execute('DELETE FROM platforms WHERE id = ?;', [id]);
    return true;
  } catch (error) {
    handleError(error, 'deletePlatform');
    return false;
  }
};

/**
 * Seeds Email + Gmail into the platforms table if they aren't there yet.
 * Safe to call every time the screen loads — it only inserts what's missing,
 * so the user can still delete/edit them like any other custom platform.
 */
export const seedDefaultPlatforms = () => {
  try {
    const existing = getAllPlatforms();
    const existingIds = new Set(existing.map((p) => p.id));
    DEFAULT_PLATFORMS.forEach((platform) => {
      if (!existingIds.has(platform.id)) {
        insertPlatform(platform);
      }
    });
  } catch (error) {
    handleError(error, 'seedDefaultPlatforms');
  }
};