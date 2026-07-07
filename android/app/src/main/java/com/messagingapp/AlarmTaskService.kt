package com.messagingapp

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Intent
import android.os.Build
import android.os.Bundle
import com.facebook.react.HeadlessJsTaskService
import com.facebook.react.bridge.Arguments
import com.facebook.react.jstasks.HeadlessJsTaskConfig

class AlarmTaskService : HeadlessJsTaskService() {

    companion object {
        private const val CHANNEL_ID = "alarm_task_service_channel"
        private const val NOTIFICATION_ID = 4271
    }

    /**
     * Must call startForeground() immediately after the service is created —
     * the OS gives only a few seconds after startForegroundService() before
     * throwing ForegroundServiceDidNotStartInTimeException. This is what
     * legally allows AlarmTaskService to run while the app is backgrounded
     * or fully killed.
     */
    override fun onCreate() {
        super.onCreate()
        createNotificationChannelIfNeeded()
        val notification = buildSilentNotification()
        startForeground(NOTIFICATION_ID, notification)
        TraceLog.d("AlarmTaskServiceForegroundStarted", mapOf("notificationId" to NOTIFICATION_ID))
    }

    private fun createNotificationChannelIfNeeded() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val manager = getSystemService(NotificationManager::class.java)
            val existing = manager?.getNotificationChannel(CHANNEL_ID)
            if (existing == null) {
                val channel = NotificationChannel(
                    CHANNEL_ID,
                    "Reminder delivery",
                    NotificationManager.IMPORTANCE_MIN,
                ).apply {
                    description = "Sends scheduled expiry reminders in the background"
                    setShowBadge(false)
                }
                manager?.createNotificationChannel(channel)
            }
        }
    }

    private fun buildSilentNotification(): Notification {
        return Notification.Builder(this, CHANNEL_ID)
            .setContentTitle("Sending reminders")
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setPriority(Notification.PRIORITY_MIN)
            .setOngoing(true)
            .build()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        TraceLog.d(
            "AlarmTaskServiceOnStartCommandStart",
            mapOf(
                "action" to intent?.action,
                "contactId" to intent?.getStringExtra("contactId"),
                "templateId" to intent?.getStringExtra("templateId"),
                "requestCode" to intent?.getIntExtra("requestCode", -1),
                "startId" to startId,
            ),
        )
        val result = super.onStartCommand(intent, flags, startId)
        TraceLog.d(
            "AlarmTaskServiceOnStartCommandEnd",
            mapOf(
                "action" to intent?.action,
                "startId" to startId,
                "serviceStartResult" to result,
            ),
        )
        return result
    }

    override fun getTaskConfig(intent: Intent?): HeadlessJsTaskConfig? {
        TraceLog.d("AlarmTaskServiceGetTaskConfigStart", mapOf("action" to intent?.action))
        if (intent == null) {
            TraceLog.d("AlarmTaskServiceGetTaskConfigExit", mapOf("exitReason" to "null_intent"))
            return null
        }

        if (intent.action == "RESCHEDULE_ALL_ALARMS") {
            TraceLog.d("AlarmTaskServiceConfigReschedule", mapOf("timeoutMs" to 60000, "taskName" to "RescheduleAlarmsTask"))
            return HeadlessJsTaskConfig(
                "RescheduleAlarmsTask",
                Arguments.createMap(),
                60000,
                false,
            )
        }

        if (intent.action == "SAFETY_NET_CHECK") {
            TraceLog.d("AlarmTaskServiceConfigSafetyNet", mapOf("timeoutMs" to 60000, "taskName" to "SafetyNetTask"))
            return HeadlessJsTaskConfig(
                "SafetyNetTask",
                Arguments.createMap(),
                60000,
                false,
            )
        }

        val extras: Bundle = intent.extras ?: run {
            TraceLog.d(
                "AlarmTaskServiceGetTaskConfigExit",
                mapOf("action" to intent.action, "exitReason" to "missing_extras"),
            )
            return null
        }
        val contactId = extras.getString("contactId")
        val templateId = extras.getString("templateId")
        val requestCode = extras.getInt("requestCode", -1)
        val data = Arguments.createMap().apply {
            putString("contactId", contactId)
            putString("templateId", templateId)
            putInt("requestCode", requestCode)
        }
        TraceLog.d(
            "AlarmTaskServiceConfigAlarmFired",
            mapOf(
                "contactId" to contactId,
                "templateId" to templateId,
                "requestCode" to requestCode,
                "taskName" to "AlarmFiredTask",
                "timeoutMs" to 30000,
                "allowedInForeground" to true,
            ),
        )
        return HeadlessJsTaskConfig(
            "AlarmFiredTask",
            data,
            30000,
            true,
        )
    }

    override fun onHeadlessJsTaskStart(taskId: Int) {
        TraceLog.d("AlarmTaskServiceHeadlessJsTaskStart", mapOf("taskId" to taskId))
        super.onHeadlessJsTaskStart(taskId)
    }

    override fun onHeadlessJsTaskFinish(taskId: Int) {
        TraceLog.d("AlarmTaskServiceHeadlessJsTaskFinish", mapOf("taskId" to taskId))
        super.onHeadlessJsTaskFinish(taskId)
    }

    override fun onDestroy() {
        TraceLog.d("AlarmTaskServiceOnDestroy", emptyMap())
        NextMessageWidgetProvider.refreshAll(applicationContext)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            stopForeground(STOP_FOREGROUND_REMOVE)
        } else {
            @Suppress("DEPRECATION")
            stopForeground(true)
        }
        super.onDestroy()
    }
}