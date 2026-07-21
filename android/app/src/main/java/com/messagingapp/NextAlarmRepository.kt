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
        // True when trigger_at has already passed but the row is still
        // 'scheduled' — i.e. it's overdue and waiting for the next
        // SafetyNetTask (15-min) cycle to actually fire it, not a
        // genuinely upcoming reminder. Computed with the exact same
        // trigger_at <= datetime('now') comparison getDueScheduledAlarms()
        // uses on the JS side, so the two never disagree about what
        // counts as "due".
        val isOverdue: Boolean,
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
                // scheduled_alarms only stores queue_id now — contact_id/
                // template_id live on message_queue, so this is a
                // double-JOIN, not a direct join like before the redesign.
                val cursor = it.rawQuery(
                    """
                    SELECT c.name AS contact_name, t.title AS template_title, sa.trigger_at AS trigger_at,
                           (sa.trigger_at <= datetime('now')) AS is_overdue
                    FROM scheduled_alarms sa
                    JOIN message_queue mq ON mq.id = sa.queue_id
                    JOIN contacts c ON c.id = mq.contact_id
                    JOIN templates t ON t.id = mq.template_id
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
                            isOverdue = c.getInt(c.getColumnIndexOrThrow("is_overdue")) != 0,
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
     * How many messages are sitting in message_queue with status='PENDING'
     * right now — items whose native alarm already fired but got deferred
     * (usually a rate limit) and are waiting for the next processQueue()
     * run to retry them. queryNextAlarm() alone can't surface this: once an
     * item's alarm has fired, there's no future scheduled_alarms row left
     * for it, so the notification silently said nothing about the backlog.
     * Returns 0 if the DB isn't reachable rather than throwing, since this
     * is a "nice to have" count, not the primary notification content.
     *
     * Unchanged by the redesign — message_queue's own columns/status
     * values didn't move, only scheduled_alarms did.
     */
    fun queryPendingCount(context: Context): Int {
        val dbFile = resolveDbFile(context) ?: return 0
        return try {
            val db = SQLiteDatabase.openDatabase(
                dbFile.absolutePath, null, SQLiteDatabase.OPEN_READONLY,
            )
            db.use {
                val cursor = it.rawQuery(
                    "SELECT COUNT(*) AS pending_count FROM message_queue WHERE status = 'PENDING';",
                    null,
                )
                cursor.use { c ->
                    if (c.moveToFirst()) c.getInt(c.getColumnIndexOrThrow("pending_count")) else 0
                }
            }
        } catch (error: Exception) {
            TraceLog.e("NextAlarmRepositoryPendingCountException", error, emptyMap())
            0
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