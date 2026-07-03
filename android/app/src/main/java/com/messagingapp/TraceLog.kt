package com.messagingapp

import android.util.Log

object TraceLog {
    private const val TAG = "MessagingTrace"

    fun d(step: String, fields: Map<String, Any?> = emptyMap()) {
        if (!BuildConfig.DEBUG) return
        Log.d(TAG, format(step, fields))
    }

    fun e(step: String, error: Throwable, fields: Map<String, Any?> = emptyMap()) {
        if (!BuildConfig.DEBUG) return
        Log.e(
            TAG,
            format(
                step,
                fields + mapOf(
                    "errorMessage" to (error.message ?: error.javaClass.simpleName),
                    "stack" to Log.getStackTraceString(error),
                ),
            ),
        )
    }

    private fun format(step: String, fields: Map<String, Any?>): String {
        val base = linkedMapOf<String, Any?>(
            "step" to step,
            "time" to java.time.Instant.now().toString(),
            "thread" to Thread.currentThread().name,
        )
        base.putAll(fields)
        return "[TRACE] " + base.entries.joinToString(" ") { (key, value) ->
            "$key=${value ?: ""}"
        }
    }
}
