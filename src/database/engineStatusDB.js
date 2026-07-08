import { getDB } from './db';
import { handleError } from '../utils/errorHandler';
import { debugTrace, debugTraceError } from '../utils/debugTrace';

/**
 * engineStatusDB
 *
 * Read-only "proof of life" for the background engine. Every trigger source
 * (AlarmReceiver → AlarmFiredTask, ExpirySafetyNetWorker → SafetyNetTask,
 * BootReceiver → RescheduleAlarmsTask) calls recordEngineRun() once it
 * finishes. UI (Settings screen, notification, widget) calls
 * getLastEngineRun() to answer "is the background engine actually alive" —
 * without depending on any live connection to the engine itself.
 *
 * Reuses the existing key-value `settings` table so no schema migration is
 * needed; a single row is overwritten each run (JSON in `value`).
 */
const ENGINE_STATUS_KEY = 'engine_last_run';

export const recordEngineRun = (triggerSource, details = {}) => {
  try {
    const db = getDB();
    const payload = JSON.stringify({
      triggerSource,
      lastRunISO: new Date().toISOString(),
      ...details,
    });
    db.execute(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value;`,
      [ENGINE_STATUS_KEY, payload],
    );
    debugTrace('RecordEngineRun', { triggerSource, ...details });
    return true;
  } catch (error) {
    debugTraceError('RecordEngineRunCatch', error, { function: 'recordEngineRun', triggerSource });
    handleError(error, 'recordEngineRun');
    return false;
  }
};

/**
 * getLastEngineRun — read-only. Returns null if the engine has never run
 * yet (fresh install before first alarm/safety-net cycle).
 */
export const getLastEngineRun = () => {
  try {
    const db = getDB();
    const row = db.execute('SELECT value FROM settings WHERE key = ?;', [ENGINE_STATUS_KEY])
      .rows?._array?.[0];
    if (!row?.value) return null;
    return JSON.parse(row.value);
  } catch (error) {
    handleError(error, 'getLastEngineRun');
    return null;
  }
};
