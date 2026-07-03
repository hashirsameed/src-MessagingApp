package com.messagingapp

import android.content.Intent
import android.os.Bundle
import com.facebook.react.HeadlessJsTaskService
import com.facebook.react.bridge.Arguments
import com.facebook.react.jstasks.HeadlessJsTaskConfig

class AlarmTaskService : HeadlessJsTaskService() {
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
        super.onDestroy()
    }
}
