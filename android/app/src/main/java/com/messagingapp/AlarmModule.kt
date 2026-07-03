package com.messagingapp

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * AlarmModule
 *
 * Wraps AlarmManager.setExactAndAllowWhileIdle() so a contact-expiry
 * reminder fires at an exact wall-clock instant — even with the app
 * fully killed and the device in Doze. Each (contact, template) pair
 * gets its own alarm, keyed by a stable integer requestCode computed
 * on the JS side (see alarmScheduler.js).
 */
class AlarmModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "AlarmModule"

    private fun buildPendingIntent(
        requestCode: Int,
        contactId: String,
        templateId: String,
    ): PendingIntent {
        TraceLog.d(
            "AlarmModuleBuildPendingIntent",
            mapOf("contactId" to contactId, "templateId" to templateId, "requestCode" to requestCode),
        )
        val context = reactApplicationContext
        val intent = Intent(context, AlarmReceiver::class.java).apply {
            putExtra("contactId", contactId)
            putExtra("templateId", templateId)
            putExtra("requestCode", requestCode)
        }
        val flags =
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            } else {
                PendingIntent.FLAG_UPDATE_CURRENT
            }
        return PendingIntent.getBroadcast(context, requestCode, intent, flags)
    }

    /**
     * @param requestCode Stable int identifying this (contactId, templateId) pair.
     * @param timestamp   Epoch millis (UTC instant) when the alarm should fire.
     */
    @ReactMethod
    fun scheduleExactAlarm(
        requestCode: Double,
        contactId: String,
        templateId: String,
        timestamp: Double,
        promise: Promise,
    ) {
        try {
            TraceLog.d(
                "AlarmModuleScheduleExactAlarmStart",
                mapOf(
                    "contactId" to contactId,
                    "templateId" to templateId,
                    "requestCode" to requestCode.toInt(),
                    "timestampMs" to timestamp.toLong(),
                ),
            )
            val context = reactApplicationContext
            val alarmManager = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
            val code = requestCode.toInt()
            val pendingIntent = buildPendingIntent(code, contactId, templateId)

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S &&
                !alarmManager.canScheduleExactAlarms()
            ) {
                TraceLog.d(
                    "AlarmModuleScheduleExactAlarmPermissionDenied",
                    mapOf("contactId" to contactId, "templateId" to templateId, "requestCode" to code),
                )
                promise.resolve("PERMISSION_DENIED")
                return
            }

            TraceLog.d(
                "AlarmModuleSetExactAndAllowWhileIdleBefore",
                mapOf("contactId" to contactId, "templateId" to templateId, "requestCode" to code),
            )
            alarmManager.setExactAndAllowWhileIdle(
                AlarmManager.RTC_WAKEUP,
                timestamp.toLong(),
                pendingIntent,
            )
            TraceLog.d(
                "AlarmModuleSetExactAndAllowWhileIdleAfter",
                mapOf("contactId" to contactId, "templateId" to templateId, "requestCode" to code),
            )
            promise.resolve("SCHEDULED")
            TraceLog.d(
                "AlarmModuleScheduleExactAlarmResolved",
                mapOf("contactId" to contactId, "templateId" to templateId, "requestCode" to code, "result" to "SCHEDULED"),
            )
        } catch (error: SecurityException) {
            TraceLog.e(
                "AlarmModuleScheduleExactAlarmSecurityException",
                error,
                mapOf("contactId" to contactId, "templateId" to templateId, "requestCode" to requestCode.toInt()),
            )
            // Thrown if SCHEDULE_EXACT_ALARM was revoked between the check and the call.
            promise.resolve("PERMISSION_DENIED")
        } catch (error: Exception) {
            TraceLog.e(
                "AlarmModuleScheduleExactAlarmException",
                error,
                mapOf("contactId" to contactId, "templateId" to templateId, "requestCode" to requestCode.toInt()),
            )
            promise.resolve("FAILED_${error.message ?: "UNKNOWN"}")
        }
    }

    @ReactMethod
    fun cancelExactAlarm(requestCode: Double, contactId: String, templateId: String, promise: Promise) {
        try {
            TraceLog.d(
                "AlarmModuleCancelExactAlarmStart",
                mapOf("contactId" to contactId, "templateId" to templateId, "requestCode" to requestCode.toInt()),
            )
            val context = reactApplicationContext
            val alarmManager = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
            val code = requestCode.toInt()
            val pendingIntent = buildPendingIntent(code, contactId, templateId)
            alarmManager.cancel(pendingIntent)
            pendingIntent.cancel()
            promise.resolve(true)
            TraceLog.d(
                "AlarmModuleCancelExactAlarmResolved",
                mapOf("contactId" to contactId, "templateId" to templateId, "requestCode" to code, "result" to true),
            )
        } catch (error: Exception) {
            TraceLog.e(
                "AlarmModuleCancelExactAlarmException",
                error,
                mapOf("contactId" to contactId, "templateId" to templateId, "requestCode" to requestCode.toInt()),
            )
            promise.resolve(false)
        }
    }

    @ReactMethod
    fun canScheduleExactAlarms(promise: Promise) {
        try {
            TraceLog.d("AlarmModuleCanScheduleExactAlarmsStart")
            val context = reactApplicationContext
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                val alarmManager = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
                val result = alarmManager.canScheduleExactAlarms()
                TraceLog.d("AlarmModuleCanScheduleExactAlarmsResolved", mapOf("result" to result))
                promise.resolve(result)
            } else {
                // Below API 31, exact alarms didn't require this runtime permission.
                TraceLog.d("AlarmModuleCanScheduleExactAlarmsResolved", mapOf("result" to true))
                promise.resolve(true)
            }
        } catch (error: Exception) {
            TraceLog.e("AlarmModuleCanScheduleExactAlarmsException", error)
            promise.resolve(false)
        }
    }

    @ReactMethod
    fun openExactAlarmSettings(promise: Promise) {
        try {
            TraceLog.d("AlarmModuleOpenExactAlarmSettingsStart")
            val context = reactApplicationContext
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                val intent = Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM).apply {
                    data = Uri.parse("package:${context.packageName}")
                    flags = Intent.FLAG_ACTIVITY_NEW_TASK
                }
                context.startActivity(intent)
            }
            promise.resolve(true)
            TraceLog.d("AlarmModuleOpenExactAlarmSettingsResolved", mapOf("result" to true))
        } catch (error: Exception) {
            TraceLog.e("AlarmModuleOpenExactAlarmSettingsException", error)
            promise.resolve(false)
        }
    }

    @ReactMethod
    fun isIgnoringBatteryOptimizations(promise: Promise) {
        try {
            TraceLog.d("AlarmModuleIsIgnoringBatteryOptimizationsStart")
            val context = reactApplicationContext
            val powerManager = context.getSystemService(Context.POWER_SERVICE) as PowerManager
            val result = powerManager.isIgnoringBatteryOptimizations(context.packageName)
            TraceLog.d("AlarmModuleIsIgnoringBatteryOptimizationsResolved", mapOf("result" to result))
            promise.resolve(result)
        } catch (error: Exception) {
            TraceLog.e("AlarmModuleIsIgnoringBatteryOptimizationsException", error)
            promise.resolve(false)
        }
    }

    @ReactMethod
    fun requestIgnoreBatteryOptimizations(promise: Promise) {
        try {
            TraceLog.d("AlarmModuleRequestIgnoreBatteryOptimizationsStart")
            val context = reactApplicationContext
            val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                data = Uri.parse("package:${context.packageName}")
                flags = Intent.FLAG_ACTIVITY_NEW_TASK
            }
            context.startActivity(intent)
            promise.resolve(true)
            TraceLog.d("AlarmModuleRequestIgnoreBatteryOptimizationsResolved", mapOf("result" to true))
        } catch (error: Exception) {
            TraceLog.e("AlarmModuleRequestIgnoreBatteryOptimizationsException", error)
            promise.resolve(false)
        }
    }
}
