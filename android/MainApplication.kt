package com.messagingapp

import android.app.Application
import android.content.Intent
import androidx.core.content.ContextCompat
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative
import com.facebook.react.defaults.DefaultReactHost.getDefaultReactHost
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import java.util.concurrent.TimeUnit

class MainApplication : Application(), ReactApplication {

  override val reactHost: ReactHost by lazy {
    getDefaultReactHost(
      context = applicationContext,
      packageList =
        PackageList(this).packages.apply {
          // Packages that cannot be autolinked yet can be added manually here.
          add(SmsPackage())
          add(AlarmPackage())
        },
    )
  }

  override fun onCreate() {
    super.onCreate()
    loadReactNative(this)
    scheduleSafetyNetWorker()
    scheduleReconcilerWorker()
    startPersistentReminderService()
  }

  /**
   * 15 minutes is the minimum interval Android allows for PeriodicWorkRequest.
   * KEEP policy means re-enqueuing on every process start (app open, boot,
   * headless task start) is a no-op if the job is already scheduled — this
   * never duplicates or resets the existing schedule.
   */
  private fun scheduleSafetyNetWorker() {
    val request = PeriodicWorkRequestBuilder<ExpirySafetyNetWorker>(15, TimeUnit.MINUTES).build()
    WorkManager.getInstance(this).enqueueUniquePeriodicWork(
      "expiry_safety_net_worker",
      ExistingPeriodicWorkPolicy.KEEP,
      request,
    )
  }

  /**
   * Level 2 / Macro Safety-Net — once a day. Separate from the 15-min
   * worker above: this one never fires a reminder, it only makes sure
   * scheduled_alarms has a row for every (contact, active template) pair.
   * KEEP policy, same reasoning as above — safe to call on every process start.
   */
  private fun scheduleReconcilerWorker() {
    val request = PeriodicWorkRequestBuilder<ReconcilerWorker>(1, TimeUnit.DAYS).build()
    WorkManager.getInstance(this).enqueueUniquePeriodicWork(
      "reconciler_daily_worker",
      ExistingPeriodicWorkPolicy.KEEP,
      request,
    )
  }

  /**
   * Every process start (app opened normally, or process recreated after
   * being killed) also (re)starts the 24/7 foreground service — BootReceiver
   * covers the reboot case, this covers every other process start. Safe to
   * call repeatedly: starting an already-running service just redelivers
   * onStartCommand, it does not create a duplicate instance.
   */
  private fun startPersistentReminderService() {
    try {
      ContextCompat.startForegroundService(this, Intent(this, PersistentReminderService::class.java))
    } catch (error: Exception) {
      TraceLog.e("MainApplicationStartPersistentServiceException", error, emptyMap())
    }
  }
}