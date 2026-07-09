package com.messagingapp

import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder

/**
 * PersistentReminderService
 *
 * A real 24/7 foreground service. Its only job is to hold a foreground
 * notification (via ReminderNotificationHelper.buildNotification, the SAME
 * builder used by the lightweight ongoing-trace path) so the OS keeps this
 * process's priority elevated and is much less likely to kill it between
 * scheduled alarms.
 *
 * Trade-offs (as agreed):
 *  - The notification becomes NON-DISMISSIBLE while this service runs —
 *    swiping it away does nothing, since Android will not let the user
 *    dismiss a foreground service's notification directly.
 *  - Battery usage goes up versus the previous "notification without a
 *    live service" design, because a foreground process is kept resident
 *    instead of being spun up only when an alarm fires.
 *  - START_STICKY: if the OS still kills this process under memory
 *    pressure, the system will attempt to recreate and restart the
 *    service shortly after, with a null intent.
 *
 * This service does NOT do the actual sending — AlarmTaskService and the
 * headless JS tasks (RescheduleAlarmsTask / AlarmFiredTask / SafetyNetTask)
 * still own that. This service is purely a keep-alive + visible-status
 * surface.
 */
class PersistentReminderService : Service() {

    companion object {
        private const val NOTIFICATION_ID = ReminderNotificationHelper.NOTIFICATION_ID_PUBLIC

        fun start(context: Context) {
            try {
                val intent = Intent(context, PersistentReminderService::class.java)
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    context.startForegroundService(intent)
                } else {
                    context.startService(intent)
                }
                TraceLog.d("PersistentReminderServiceStartRequested", emptyMap())
            } catch (error: Exception) {
                TraceLog.e("PersistentReminderServiceStartRequestFailed", error, emptyMap())
            }
        }

        fun stop(context: Context) {
            try {
                context.stopService(Intent(context, PersistentReminderService::class.java))
            } catch (error: Exception) {
                TraceLog.e("PersistentReminderServiceStopFailed", error, emptyMap())
            }
        }
    }

    override fun onCreate() {
        super.onCreate()
        TraceLog.d("PersistentReminderServiceOnCreate", emptyMap())
        try {
            val notification = ReminderNotificationHelper.buildNotification(applicationContext)
            startForeground(NOTIFICATION_ID, notification)
            TraceLog.d("PersistentReminderServiceForegroundStarted", mapOf("notificationId" to NOTIFICATION_ID))
        } catch (error: Exception) {
            // If startForeground() itself fails (e.g. missing permission at
            // runtime), do not leave the service half-alive — stop cleanly
            // rather than crash-looping.
            TraceLog.e("PersistentReminderServiceForegroundStartFailed", error, emptyMap())
            stopSelf()
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        TraceLog.d(
            "PersistentReminderServiceOnStartCommand",
            mapOf("startId" to startId, "restarted" to (intent == null)),
        )
        // Keep the notification content fresh (next-alarm time changes as
        // alarms fire/reschedule) any time the service is (re)started.
        try {
            val notification = ReminderNotificationHelper.buildNotification(applicationContext)
            startForeground(NOTIFICATION_ID, notification)
        } catch (error: Exception) {
            TraceLog.e("PersistentReminderServiceRefreshFailed", error, emptyMap())
        }
        // START_STICKY: ask the OS to recreate this service (with a null
        // intent) if it gets killed, instead of leaving it dead.
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        TraceLog.d("PersistentReminderServiceOnDestroy", emptyMap())
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            stopForeground(STOP_FOREGROUND_REMOVE)
        } else {
            @Suppress("DEPRECATION")
            stopForeground(true)
        }
        super.onDestroy()
    }
}
