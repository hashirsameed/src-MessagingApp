package com.messagingapp

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.database.sqlite.SQLiteDatabase
import android.os.Build
import android.widget.RemoteViews
import java.io.File
import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone

/**
 * NextMessageWidgetProvider
 *
 * Home-screen widget showing which contact the next scheduled reminder will
 * go to, and when. Reads scheduled_alarms/contacts/templates directly from
 * the app's SQLite file (react-native-quick-sqlite stores it under the
 * app's `files` directory on Android) — this is intentionally independent
 * of the JS runtime, so the widget stays accurate even if the app process
 * itself is fully killed.
 *
 * Refreshed from three places rather than relying only on the OS-imposed
 * 30-minute minimum update interval (see next_message_widget_info.xml):
 *   1. AlarmModule.scheduleExactAlarm / cancelExactAlarm — any time JS
 *      changes what's scheduled.
 *   2. AlarmTaskService.onDestroy — after any headless task finishes
 *      (alarm fired, boot reschedule, safety-net check), since any of
 *      those can change which contact is "next".
 */
class NextMessageWidgetProvider : AppWidgetProvider() {

    override fun onUpdate(context: Context, appWidgetManager: AppWidgetManager, appWidgetIds: IntArray) {
        val views = buildViews(context)
        for (id in appWidgetIds) {
            appWidgetManager.updateAppWidget(id, views)
        }
    }

    companion object {
        private const val DB_FILE_NAME = "MessagingApp.db"

        /** Called from native code (not JS) whenever the scheduled set could have changed. */
        fun refreshAll(context: Context) {
            try {
                val manager = AppWidgetManager.getInstance(context)
                val component = ComponentName(context, NextMessageWidgetProvider::class.java)
                val ids = manager.getAppWidgetIds(component)
                if (ids.isEmpty()) return
                val views = buildViews(context)
                manager.updateAppWidget(component, views)
                TraceLog.d("NextMessageWidgetRefreshed", mapOf("widgetCount" to ids.size))
            } catch (error: Exception) {
                TraceLog.e("NextMessageWidgetRefreshException", error, emptyMap())
            }
        }

        private fun resolveDbFile(context: Context): File? {
            // react-native-quick-sqlite (8.x) opens databases under the app's
            // `files` directory on Android when no explicit `location` is
            // passed — this app's db.js calls open({ name: 'MessagingApp.db' })
            // with no location override.
            val filesDirCandidate = File(context.filesDir, DB_FILE_NAME)
            if (filesDirCandidate.exists()) return filesDirCandidate

            // Fallback: some quick-sqlite versions/configs use the standard
            // Android `databases` folder instead. Try both rather than
            // guessing wrong and showing a blank widget forever.
            val databasesDirCandidate = context.getDatabasePath(DB_FILE_NAME)
            if (databasesDirCandidate.exists()) return databasesDirCandidate

            return null
        }

        private fun buildViews(context: Context): RemoteViews {
            val views = RemoteViews(context.packageName, R.layout.widget_next_message)

            val launchIntent = context.packageManager.getLaunchIntentForPackage(context.packageName)
            if (launchIntent != null) {
                val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
                } else {
                    PendingIntent.FLAG_UPDATE_CURRENT
                }
                val pendingIntent = PendingIntent.getActivity(context, 0, launchIntent, flags)
                views.setOnClickPendingIntent(R.id.widget_contact_name, pendingIntent)
            }

            try {
                val dbFile = resolveDbFile(context) ?: run {
                    setEmptyState(views, "Open app to set up reminders")
                    return views
                }

                val db = SQLiteDatabase.openDatabase(
                    dbFile.absolutePath, null, SQLiteDatabase.OPEN_READONLY,
                )
                db.use {
                    val cursor = it.rawQuery(
                        """
                        SELECT c.name AS contact_name, t.title AS template_title, sa.trigger_at AS trigger_at
                        FROM scheduled_alarms sa
                        JOIN contacts c ON c.id = sa.contact_id
                        JOIN templates t ON t.id = sa.template_id
                        WHERE sa.status = 'scheduled'
                        ORDER BY sa.trigger_at ASC
                        LIMIT 1;
                        """.trimIndent(),
                        null,
                    )
                    cursor.use { c ->
                        if (c.moveToFirst()) {
                            val contactName = c.getString(c.getColumnIndexOrThrow("contact_name"))
                            val templateTitle = c.getString(c.getColumnIndexOrThrow("template_title"))
                            val triggerAt = c.getString(c.getColumnIndexOrThrow("trigger_at"))
                            views.setTextViewText(R.id.widget_contact_name, contactName)
                            views.setTextViewText(R.id.widget_template_title, templateTitle)
                            views.setTextViewText(R.id.widget_trigger_time, formatPakistanTime(triggerAt))
                        } else {
                            setEmptyState(views, "No upcoming reminders")
                        }
                    }
                }
            } catch (error: Exception) {
                TraceLog.e("NextMessageWidgetBuildViewsException", error, emptyMap())
                setEmptyState(views, "Open app to refresh")
            }

            return views
        }

        private fun setEmptyState(views: RemoteViews, message: String) {
            views.setTextViewText(R.id.widget_contact_name, message)
            views.setTextViewText(R.id.widget_template_title, "")
            views.setTextViewText(R.id.widget_trigger_time, "")
        }

        /**
         * trigger_at is stored as a UTC ISO instant (e.g. "2026-07-10T09:00:00Z").
         * Displayed in Pakistan wall-clock time — fixed UTC+5, no DST — same
         * convention as the rest of the app (see src/utils/pakistanTime.js).
         */
        private fun formatPakistanTime(triggerAtIso: String): String {
            return try {
                val parser = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.US).apply {
                    timeZone = TimeZone.getTimeZone("UTC")
                }
                val date = parser.parse(triggerAtIso) ?: return ""
                val formatter = SimpleDateFormat("d MMM, h:mm a", Locale.US).apply {
                    timeZone = TimeZone.getTimeZone("Asia/Karachi")
                }
                formatter.format(date)
            } catch (error: Exception) {
                ""
            }
        }
    }
}