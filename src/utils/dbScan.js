import { handleError } from './errorHandler';
import { debugTrace, debugTraceError } from './debugTrace';
import { getAllActiveScheduledAlarms, getDueScheduledAlarms } from '../database/scheduledAlarmDB';
import { getPendingQueue } from '../database/messageQueueDB';

/**
 * scanDatabase — the single, pure-read observation layer shared by:
 *   - alarmHeadlessTask.js's SafetyNetTask (acts on `overdue`)
 *   - alarmHeadlessTask.js's ReconcilerTask (logs the snapshot only)
 *   - ContactListScreen.js's Test-panel "Scan" button (display only)
 *
 * This is deliberately just a thin composition over the already-correct,
 * already-shared queries in scheduledAlarmDB.js and messageQueueDB.js —
 * it does NOT define its own SQL/JOIN shape. That's intentional: those
 * two files are the source of truth for what "scheduled", "due", and
 * "pending" mean post-redesign (contact_id/template_id now live on
 * message_queue, scheduled_alarms only holds queue_id), so re-deriving
 * the same thing here with fresh SQL would risk drifting from them the
 * same way NextAlarmRepository.kt would if it didn't share a query too.
 *
 * Never writes anything — no claim, no status change, no alarm/SMS side
 * effect. Every consumer above treats this as a snapshot: SafetyNetTask
 * acts on what it returns, but the acting itself happens in
 * fireScheduledPair(), not here.
 */
export const scanDatabase = () => {
  try {
    const scheduled = getAllActiveScheduledAlarms(); // status = 'scheduled', includes overdue ones
    const overdue = getDueScheduledAlarms();          // status = 'scheduled' AND trigger_at <= now
    const pendingQueue = getPendingQueue();           // message_queue rows still PENDING

    const summary = {
      scheduledCount: scheduled.length,
      overdueCount: overdue.length,
      pendingQueueCount: pendingQueue.length,
    };

    debugTrace('ScanDatabaseResult', summary);

    return {
      scheduled,
      overdue,
      pendingQueue,
      summary,
    };
  } catch (error) {
    debugTraceError('ScanDatabaseCatch', error, { function: 'scanDatabase' });
    handleError(error, 'scanDatabase');
    return {
      scheduled: [],
      overdue: [],
      pendingQueue: [],
      summary: { scheduledCount: 0, overdueCount: 0, pendingQueueCount: 0 },
    };
  }
};