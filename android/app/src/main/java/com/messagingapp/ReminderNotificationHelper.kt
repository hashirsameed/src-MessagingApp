package com.messagingapp

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.os.Build

/**
 * ReminderNotificationHelper
 *
 * The visible "trace" that the app is alive in the background. Unlike
 * AlarmTaskService's own short-lived foreground notification (only shown
 * for the few seconds it takes to process one fired alarm), this
 * notification is posted/updated as an ongoing NotificationManager entry —
 * it does not require a continuously-running foreground service, so it
 * survives independent of any single service's lifecycle and doesn't drain
 * battery the way a 24/7 foreground service would.
 *
 * Posted/refreshed from four points, matching the architecture agreed:
 *   1. App transitions to background (AlarmModule.showBackgroundTraceNotification,
 *      called from JS via an AppState listener).
 *   2. A new alarm is scheduled/rescheduled (AlarmModule.scheduleExactAlarm).
 *   3. An alarm fires and the queue changes (AlarmTaskService.onDestroy).
 *   4. Boot rearm completes (BootReceiver, via AlarmTaskService's headless
 *      task finishing RescheduleAlarmsTask, which already routes through
 *      onDestroy above).
 *
 * Content is read via NextAlarmRepository — same query the widget uses, so
 * notification and widget can never show conflicting information.
 */
object ReminderNotificationHelper {

    private const val CHANNEL_ID = "background_trace_channel"
    private const val NOTIFICATION_ID = 4272

    private fun ensureChannel(context: Context) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val manager = context.getSystemService(NotificationManager::class.java)
            if (manager?.getNotificationChannel(CHANNEL_ID) == null) {
                val channel = NotificationChannel(
                    CHANNEL_ID,
                    "Background status",
                    NotificationManager.IMPORTANCE_LOW,
                ).apply {
                    description = "Shows the next scheduled reminder while the app runs in the background"
                    setShowBadge(false)
                }
                manager?.createNotificationChannel(channel)
            }
        }
    }

    /** Builds and posts (or updates) the ongoing background-trace notification. */
    fun postOrUpdate(context: Context) {
        try {
            ensureChannel(context)
            val manager = context.getSystemService(NotificationManager::class.java) ?: return

            val next = NextAlarmRepository.queryNextAlarm(context)

            val (title, body) = if (next != null) {
                "Reminder engine active" to
                    "Next: ${next.contactName} — ${next.templateTitle} at ${NextAlarmRepository.formatPakistanTime(next.triggerAtIso)}"
            } else {
                "Reminder engine active" to "No upcoming reminders scheduled"
            }

            val launchIntent = context.packageManager.getLaunchIntentForPackage(context.packageName)
            val contentIntent = launchIntent?.let {
                val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
                } else {
                    PendingIntent.FLAG_UPDATE_CURRENT
                }
                PendingIntent.getActivity(context, 0, it, flags)
            }

            val builder = Notification.Builder(context, CHANNEL_ID)
                .setContentTitle(title)
                .setContentText(body)
                .setSmallIcon(android.R.drawable.stat_notify_sync)
                .setPriority(Notification.PRIORITY_LOW)
                .setOngoing(true)
                .setOnlyAlertOnce(true)

            if (contentIntent != null) {
                builder.setContentIntent(contentIntent)
            }

            manager.notify(NOTIFICATION_ID, builder.build())
            TraceLog.d(
                "BackgroundTraceNotificationPosted",
                mapOf("hasNextAlarm" to (next != null)),
            )
        } catch (error: Exception) {
            TraceLog.e("BackgroundTraceNotificationException", error, emptyMap())
        }
    }

    /** Called when the app returns to foreground — the UI itself is proof of life now. */
    fun cancel(context: Context) {
        try {
            val manager = context.getSystemService(NotificationManager::class.java)
            manager?.cancel(NOTIFICATION_ID)
        } catch (error: Exception) {
            TraceLog.e("BackgroundTraceNotificationCancelException", error, emptyMap())
        }
    }
}
