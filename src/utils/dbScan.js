import { handleError } from './errorHandler';
import { debugTrace, debugTraceError } from './debugTrace';
import { getAllActiveScheduledAlarms } from '../database/scheduledAlarmDB';
import { getPendingQueue } from '../database/messageQueueDB';

/**
 * scanDatabase — the single, pure-read observation layer shared by:
 *   - alarmHeadlessTask.js's SafetyNetTask (acts on `overdue`)
 *   - alarmHeadlessTask.js's ReconcilerTask (logs the snapshot only)
 *   - ContactListScreen.js's Test-panel "Scan" button (display only)
 *
 * Uses a SINGLE query (getAllActiveScheduledAlarms) with an is_overdue
 * computed column, avoiding the redundant JOIN that previously happened
 * when calling both getAllActiveScheduledAlarms AND getDueScheduledAlarms.
 *
 * Never writes anything — no claim, no status change, no alarm/SMS side
 * effect. Every consumer above treats this as a snapshot: SafetyNetTask
 * acts on what it returns, but the acting itself happens in
 * fireScheduledPair(), not here.
 */
export const scanDatabase = () => {
  try {
    const scheduled = getAllActiveScheduledAlarms(); // includes is_overdue flag
    const overdue = scheduled.filter((a) => a.is_overdue === 1);
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