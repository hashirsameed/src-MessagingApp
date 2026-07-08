package com.messagingapp

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import java.io.File
import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone

/**
 * NextAlarmRepository
 *
 * Single source of the "what's the next scheduled reminder" query, read
 * directly from the app's SQLite file — independent of the JS runtime, so
 * it stays accurate even if the app process is fully killed.
 *
 * Consumed by two independent, read-only surfaces that must never disagree:
 *   - NextMessageWidgetProvider (home-screen widget)
 *   - ReminderNotificationHelper (persistent background-trace notification)
 *
 * Extracted out of NextMessageWidgetProvider so both surfaces share exactly
 * one query instead of drifting apart over time.
 */
object NextAlarmRepository {

    private const val DB_FILE_NAME = "MessagingApp.db"

    data class NextAlarm(
        val contactName: String,
        val templateTitle: String,
        val triggerAtIso: String,
    )

    /**
     * react-native-quick-sqlite (8.x) opens databases under the app's
     * `files` directory on Android when no explicit `location` is passed —
     * db.js calls open({ name: 'MessagingApp.db' }) with no location
     * override. Fallback checks the standard `databases` folder too.
     */
    fun resolveDbFile(context: Context): File? {
        val filesDirCandidate = File(context.filesDir, DB_FILE_NAME)
        if (filesDirCandidate.exists()) return filesDirCandidate

        val databasesDirCandidate = context.getDatabasePath(DB_FILE_NAME)
        if (databasesDirCandidate.exists()) return databasesDirCandidate

        return null
    }

    /** Returns null if the DB isn't reachable yet, or no alarm is scheduled. */
    fun queryNextAlarm(context: Context): NextAlarm? {
        val dbFile = resolveDbFile(context) ?: return null
        return try {
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
                        NextAlarm(
                            contactName = c.getString(c.getColumnIndexOrThrow("contact_name")),
                            templateTitle = c.getString(c.getColumnIndexOrThrow("template_title")),
                            triggerAtIso = c.getString(c.getColumnIndexOrThrow("trigger_at")),
                        )
                    } else {
                        null
                    }
                }
            }
        } catch (error: Exception) {
            TraceLog.e("NextAlarmRepositoryQueryException", error, emptyMap())
            null
        }
    }

    /**
     * trigger_at is stored as a UTC ISO instant (e.g. "2026-07-10T09:00:00Z").
     * Displayed in Pakistan wall-clock time — fixed UTC+5, no DST — same
     * convention as src/utils/pakistanTime.js.
     */
    fun formatPakistanTime(triggerAtIso: String): String {
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
