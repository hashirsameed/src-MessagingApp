import { getAllActiveScheduledAlarms, getDueScheduledAlarms } from '../database/scheduledAlarmDB';
import { getAllQueue } from '../database/messageQueueDB';
import { handleError } from './errorHandler';

/**
 * scanDatabase — READ-ONLY. Looks at scheduled_alarms and message_queue
 * and reports what it finds. Does not write anything, does not fire any
 * alarm, does not send any message, does not touch AlarmManager, does not
 * call fireScheduledPair() or processQueue() or scheduleAlarmsForContact().
 * Every function it calls underneath (getAllActiveScheduledAlarms,
 * getDueScheduledAlarms, getAllQueue) is itself a plain SELECT — no
 * INSERT/UPDATE/DELETE anywhere in this call path.
 *
 * Safe to call as often as wanted (button-mash it) — it can never change
 * app state or send a real message, only report on it.
 *
 * Returns:
 * {
 *   scannedAt: ISO timestamp of when this scan ran,
 *   scheduled: [ all rows still status='scheduled' ],
 *   overdue:   [ subset of the above whose trigger_at has already passed —
 *               same rows SafetyNetTask would act on, but nothing here
 *               acts on them ],
 *   queuePending: [ message_queue rows not yet SENT/FAILED ],
 *   summary: { scheduledCount, overdueCount, pendingQueueCount }
 * }
 */
export const scanDatabase = () => {
  try {
    const scheduled = getAllActiveScheduledAlarms();
    const overdue = getDueScheduledAlarms();
    const allQueue = getAllQueue();
    const queuePending = allQueue.filter(
      (row) => row.status !== 'SENT' && row.status !== 'FAILED',
    );

    return {
      scannedAt: new Date().toISOString(),
      scheduled,
      overdue,
      queuePending,
      summary: {
        scheduledCount: scheduled.length,
        overdueCount: overdue.length,
        pendingQueueCount: queuePending.length,
      },
    };
  } catch (error) {
    handleError(error, 'scanDatabase');
    return {
      scannedAt: new Date().toISOString(),
      scheduled: [],
      overdue: [],
      queuePending: [],
      summary: { scheduledCount: 0, overdueCount: 0, pendingQueueCount: 0 },
    };
  }
};