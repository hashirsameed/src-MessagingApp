package com.messagingapp

import android.content.Context
import android.content.Intent
import androidx.work.Worker
import androidx.work.WorkerParameters

/**
 * ReconcilerWorker
 *
 * Level 2 / Macro Safety-Net. Runs once a day (the minimum useful cadence
 * for this — it is not a firing path, just a "did every contact get a
 * scheduled_alarms row" audit). Unlike ExpirySafetyNetWorker, this never
 * sends anything; it only makes sure scheduled_alarms has a row for every
 * (contact, active template) pair, so the 15-minute SafetyNetTask always
 * has something to find. Covers the rare case where the synchronous
 * scheduling call at contact-add/template-edit time didn't complete or
 * persist (app killed mid-write, native module error, permission not yet
 * granted at that moment).
 */
class ReconcilerWorker(
    context: Context,
    params: WorkerParameters,
) : Worker(context, params) {

    override fun doWork(): Result {
        return try {
            TraceLog.d("ReconcilerWorkerDoWorkStart", emptyMap())
            val serviceIntent = Intent(applicationContext, AlarmTaskService::class.java).apply {
                action = "RECONCILE_CHECK"
            }
            applicationContext.startForegroundService(serviceIntent)
            TraceLog.d("ReconcilerWorkerDoWorkEnd", mapOf("result" to "success"))
            Result.success()
        } catch (error: Exception) {
            TraceLog.e("ReconcilerWorkerException", error, emptyMap())
            Result.retry()
        }
    }
}