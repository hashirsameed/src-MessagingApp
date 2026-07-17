package com.messagingapp

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Build
import android.widget.RemoteViews

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

            if (NextAlarmRepository.resolveDbFile(context) == null) {
                setEmptyState(views, "Open app to set up reminders")
                return views
            }

            val next = NextAlarmRepository.queryNextAlarm(context)
            if (next == null) {
                setEmptyState(views, "No upcoming reminders")
                return views
            }

            views.setTextViewText(R.id.widget_contact_name, next.contactName)
            views.setTextViewText(R.id.widget_template_title, next.templateTitle)
            views.setTextViewText(
                R.id.widget_trigger_time,
                if (next.isOverdue) "Sending shortly" else NextAlarmRepository.formatPakistanTime(next.triggerAtIso),
            )

            return views
        }

        private fun setEmptyState(views: RemoteViews, message: String) {
            views.setTextViewText(R.id.widget_contact_name, message)
            views.setTextViewText(R.id.widget_template_title, "")
            views.setTextViewText(R.id.widget_trigger_time, "")
        }
    }
}