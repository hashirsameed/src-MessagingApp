package com.messagingapp

import android.app.Application
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
    startPersistentReminderService()
  }

  /**
   * Starts the 24/7 foreground reminder service on every normal process
   * start (app opened by the user, process restarted by the OS, etc.) —
   * not just after boot. BootReceiver already starts it after a reboot;
   * this covers every other case where the process comes up.
   * PersistentReminderService.start() is itself idempotent-safe: calling
   * startForegroundService() while the service is already running just
   * redelivers onStartCommand(), it doesn't create a second instance.
   */
  private fun startPersistentReminderService() {
    PersistentReminderService.start(applicationContext)
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
}