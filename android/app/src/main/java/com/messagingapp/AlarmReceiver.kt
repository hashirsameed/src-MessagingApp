package com.messagingapp

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.os.PowerManager // Added missing import
import com.facebook.react.HeadlessJsTaskService

/**
 * Fires when AlarmManager wakes the device for a scheduled expiry reminder.
 * Hands off to AlarmTaskService, which boots a Headless JS context (even
 * with the app fully killed) to run alarmHeadlessTask.js — that JS task
 * fetches the contact, builds the message, and queues/dispatches it via
 * queueProcessor.js.
 */
class AlarmReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val contactId = intent.getStringExtra("contactId")
        val templateId = intent.getStringExtra("templateId")
        val requestCode = intent.getIntExtra("requestCode", -1)
        TraceLog.d(
            "AlarmReceiverOnReceiveStart",
            mapOf(
                "contactId" to contactId,
                "templateId" to templateId,
                "requestCode" to requestCode,
                "action" to intent.action,
            ),
        )

        val serviceIntent = Intent(context, AlarmTaskService::class.java).apply {
            putExtras(Bundle().apply {
                putString("contactId", contactId)
                putString("templateId", templateId)
                putInt("requestCode", requestCode)
            })
        }
        try {
            TraceLog.d(
                "AlarmReceiverStartServiceBefore",
                mapOf("contactId" to contactId, "templateId" to templateId, "requestCode" to requestCode)
            )
            
            // Acquire wake lock BEFORE starting service to keep CPU awake
            val pm = context.getSystemService(Context.POWER_SERVICE) as PowerManager
            val wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "MessagingApp:AlarmReceiver")
            wakeLock.acquire(60 * 1000L) // 60 seconds

            context.startForegroundService(serviceIntent)
            TraceLog.d(
                "AlarmReceiverStartServiceAfter",
                mapOf("contactId" to contactId, "templateId" to templateId, "requestCode" to requestCode),
            )
            
            TraceLog.d(
                "AlarmReceiverWakeLockBefore",
                mapOf("contactId" to contactId, "templateId" to templateId, "requestCode" to requestCode),
            )
            HeadlessJsTaskService.acquireWakeLockNow(context)
            TraceLog.d(
                "AlarmReceiverWakeLockAfter",
                mapOf("contactId" to contactId, "templateId" to templateId, "requestCode" to requestCode),
            )
        } catch (error: IllegalStateException) {
            TraceLog.e(
                "AlarmReceiverStartServiceIllegalState",
                error,
                mapOf("contactId" to contactId, "templateId" to templateId, "requestCode" to requestCode),
            )
        } catch (error: Exception) {
            TraceLog.e(
                "AlarmReceiverUnexpectedFailure",
                error,
                mapOf("contactId" to contactId, "templateId" to templateId, "requestCode" to requestCode),
            )
        }
        TraceLog.d(
            "AlarmReceiverOnReceiveEnd",
            mapOf("contactId" to contactId, "templateId" to templateId, "requestCode" to requestCode),
        )
    }
}