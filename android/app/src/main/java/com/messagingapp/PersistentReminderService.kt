package com.messagingapp

import android.app.Service
import android.content.Intent
import android.os.Handler
import android.os.IBinder
import android.os.Looper

/**
 * PersistentReminderService
 *
 * Max-reliability mode: a genuine 24/7 foreground service, not just an
 * ongoing notification. As long as this service is alive, Android treats
 * the whole app process as foreground-priority — it is far less likely to
 * be killed under memory pressure than a plain background/headless process,
 * and its notification cannot be swiped away by the user while the service
 * runs (only stopping the service removes it).
 *
 * Trade-off, stated plainly: this keeps the process resident continuously,
 * which costs more battery than the previous "notification only when
 * backgrounded" approach, and the notification is now permanently visible
 * (not just while backgrounded) — that permanence is what buys the
 * reliability.
 *
 * This service does NOT run the scheduling/dispatch logic itself — that
 * still happens in AlarmTaskService's headless tasks, triggered by
 * AlarmManager/WorkManager/BootReceiver exactly as before. This service's
 * only job is to (a) stay alive so the OS deprioritizes killing the
 * process, and (b) keep the "next reminder" notification current by
 * refreshing it on a fixed interval, independent of whether any alarm
 * happens to fire.
 */
class PersistentReminderService : Service() {

    companion object {
        private const val REFRESH_INTERVAL_MS = 15 * 60 * 1000L // 15 minutes
    }

    private val refreshHandler = Handler(Looper.getMainLooper())
    private val refreshRunnable = object : Runnable {
        override fun run() {
            ReminderNotificationHelper.postOrUpdate(applicationContext)
            NextMessageWidgetProvider.refreshAll(applicationContext)
            refreshHandler.postDelayed(this, REFRESH_INTERVAL_MS)
        }
    }

    override fun onCreate() {
        super.onCreate()
        TraceLog.d("PersistentReminderServiceOnCreate", emptyMap())
        ReminderNotificationHelper.ensureChannel(applicationContext)
        val notification = ReminderNotificationHelper.buildNotification(applicationContext)
        startForeground(ReminderNotificationHelper.NOTIFICATION_ID, notification)
        refreshHandler.postDelayed(refreshRunnable, REFRESH_INTERVAL_MS)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        TraceLog.d("PersistentReminderServiceOnStartCommand", mapOf("startId" to startId))
        // START_STICKY: if the OS kills this service to reclaim memory, it
        // recreates it (with a null intent) as soon as resources allow —
        // this is the second half of "reliably alive", alongside boot-start.
        return START_STICKY
    }

    override fun onDestroy() {
        TraceLog.d("PersistentReminderServiceOnDestroy", emptyMap())
        refreshHandler.removeCallbacks(refreshRunnable)
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null
}
