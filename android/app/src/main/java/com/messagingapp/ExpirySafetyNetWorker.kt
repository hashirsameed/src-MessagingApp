package com.messagingapp

import android.content.Context
import android.content.Intent
import androidx.work.Worker
import androidx.work.WorkerParameters

/**
 * ExpirySafetyNetWorker
 *
 * AlarmManager's setExactAndAllowWhileIdle() is the primary background
 * trigger and should fire on time on stock Android. In practice, several
 * OEM battery managers (Xiaomi/MIUI, Vivo/FuntouchOS, Oppo/ColorOS,
 * Infinix/Tecno/XOS) kill scheduled alarms outright regardless of correct
 * AlarmManager/foreground-service code, unless the user has manually
 * whitelisted the app in that OEM's own battery/autostart settings.
 *
 * This worker is a second, independent line of defense: WorkManager uses
 * its own JobScheduler/AlarmManager-backed dispatch under the hood, which
 * OEM battery managers are generally less aggressive about killing since
 * many system services depend on WorkManager staying alive. It runs on a
 * periodic ~15 minute cadence (the minimum Android allows for periodic
 * work) and re-checks for anything due that the primary path may have
 * missed — it does NOT replace the exact-alarm path, it backstops it.
 */
class ExpirySafetyNetWorker(
    context: Context,
    params: WorkerParameters,
) : Worker(context, params) {

    override fun doWork(): Result {
        return try {
            TraceLog.d("ExpirySafetyNetWorkerDoWorkStart", emptyMap())
            val serviceIntent = Intent(applicationContext, AlarmTaskService::class.java).apply {
                action = "SAFETY_NET_CHECK"
            }
            applicationContext.startForegroundService(serviceIntent)
            TraceLog.d("ExpirySafetyNetWorkerDoWorkEnd", mapOf("result" to "success"))
            Result.success()
        } catch (error: Exception) {
            TraceLog.e("ExpirySafetyNetWorkerException", error, emptyMap())
            // Retry with WorkManager's own backoff policy rather than failing
            // permanently — a transient failure here (e.g. service already
            // starting) shouldn't disable the safety net until next periodic run.
            Result.retry()
        }
    }
}