package com.messagingapp

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.facebook.react.HeadlessJsTaskService

/**
 * AlarmManager alarms are cleared on every device reboot. This receiver
 * fires on BOOT_COMPLETED and boots a Headless JS task that re-reads every
 * future contact + active template combination from SQLite and re-schedules
 * each alarm (see alarmScheduler.js -> rescheduleAllAlarms).
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        TraceLog.d("BootReceiverOnReceiveStart", mapOf("action" to intent.action))
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) {
            TraceLog.d("BootReceiverIgnoredAction", mapOf("action" to intent.action))
            return
        }

        val serviceIntent = Intent(context, AlarmTaskService::class.java).apply {
            action = "RESCHEDULE_ALL_ALARMS"
        }
        try {
            TraceLog.d("BootReceiverStartServiceBefore", mapOf("action" to serviceIntent.action))
            context.startForegroundService(serviceIntent)
            TraceLog.d("BootReceiverStartServiceAfter", mapOf("action" to serviceIntent.action))
            TraceLog.d("BootReceiverWakeLockBefore", mapOf("action" to serviceIntent.action))
            HeadlessJsTaskService.acquireWakeLockNow(context)
            TraceLog.d("BootReceiverWakeLockAfter", mapOf("action" to serviceIntent.action))
        } catch (error: IllegalStateException) {
            TraceLog.e("BootReceiverStartServiceIllegalState", error, mapOf("action" to serviceIntent.action))
        } catch (error: Exception) {
            TraceLog.e("BootReceiverUnexpectedFailure", error, mapOf("action" to serviceIntent.action))
        }
        TraceLog.d("BootReceiverOnReceiveEnd", mapOf("action" to intent.action))
    }
}