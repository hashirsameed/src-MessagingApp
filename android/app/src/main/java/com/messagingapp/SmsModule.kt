package com.messagingapp

import android.app.Activity
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.telephony.SmsManager
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * SmsModule
 *
 * Sends an SMS via the native SmsManager and waits for the ACTUAL
 * carrier-level result using PendingIntent broadcasts — not just
 * "the call returned" like react-native-sms gives you.
 *
 * This correctly distinguishes:
 *   - RESULT_OK                      -> truly sent to the network
 *   - RESULT_ERROR_GENERIC_FAILURE   -> generic failure (often no balance/SIM issue)
 *   - RESULT_ERROR_NO_SERVICE        -> no network/service
 *   - RESULT_ERROR_RADIO_OFF         -> airplane mode / radio off
 *   - RESULT_ERROR_NULL_PDU          -> malformed message
 *
 * Each send() call registers a one-shot BroadcastReceiver, waits for the
 * result, unregisters itself, and resolves the JS Promise with a precise
 * status string so queueProcessor.js can mark the queue item SENT or
 * FAILED with an accurate reason instead of a false-positive "completed".
 */
class SmsModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "SmsModule"

    @ReactMethod
    fun sendSms(phoneNumber: String, message: String, promise: Promise) {
        try {
            TraceLog.d(
                "SmsModuleSendSmsStart",
                mapOf("phoneNumber" to phoneNumber, "messageLength" to message.length),
            )
            val context = reactApplicationContext
            val smsManager: SmsManager =
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    context.getSystemService(SmsManager::class.java)
                } else {
                    @Suppress("DEPRECATION")
                    SmsManager.getDefault()
                }

            val sentAction = "SMS_SENT_ACTION_${System.currentTimeMillis()}"
            TraceLog.d("SmsModuleSentActionCreated", mapOf("sentAction" to sentAction))

            val sentIntent = Intent(sentAction).apply {
                setPackage(context.packageName)
            }

            val pendingIntentFlags =
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE
                } else {
                    PendingIntent.FLAG_UPDATE_CURRENT
                }

            val sentPendingIntent = PendingIntent.getBroadcast(
                context, 0, sentIntent, pendingIntentFlags,
            )

            val receiver = object : BroadcastReceiver() {
                override fun onReceive(ctx: Context, intent: Intent) {
                    TraceLog.d(
                        "SmsModuleCallbackReceived",
                        mapOf("sentAction" to intent.action, "resultCode" to resultCode),
                    )
                    // Always unregister first — this receiver is one-shot.
                    try {
                        context.unregisterReceiver(this)
                        TraceLog.d("SmsModuleCallbackReceiverUnregistered", mapOf("sentAction" to intent.action))
                    } catch (_: IllegalArgumentException) {
                        TraceLog.d("SmsModuleCallbackReceiverAlreadyUnregistered", mapOf("sentAction" to intent.action))
                        // Already unregistered — safe to ignore.
                    }

                    when (resultCode) {
                        Activity.RESULT_OK -> {
                            TraceLog.d("SmsModulePromiseResolve", mapOf("sentAction" to intent.action, "result" to "SENT"))
                            promise.resolve("SENT")
                        }
                        SmsManager.RESULT_ERROR_GENERIC_FAILURE -> {
                            // Most common code for: no balance, SIM rejected,
                            // operator-side block, or unspecified carrier failure.
                            TraceLog.d("SmsModulePromiseResolve", mapOf("sentAction" to intent.action, "result" to "FAILED_GENERIC_FAILURE"))
                            promise.resolve("FAILED_GENERIC_FAILURE")
                        }
                        SmsManager.RESULT_ERROR_NO_SERVICE -> {
                            TraceLog.d("SmsModulePromiseResolve", mapOf("sentAction" to intent.action, "result" to "FAILED_NO_SERVICE"))
                            promise.resolve("FAILED_NO_SERVICE")
                        }
                        SmsManager.RESULT_ERROR_RADIO_OFF -> {
                            TraceLog.d("SmsModulePromiseResolve", mapOf("sentAction" to intent.action, "result" to "FAILED_RADIO_OFF"))
                            promise.resolve("FAILED_RADIO_OFF")
                        }
                        SmsManager.RESULT_ERROR_NULL_PDU -> {
                            TraceLog.d("SmsModulePromiseResolve", mapOf("sentAction" to intent.action, "result" to "FAILED_NULL_PDU"))
                            promise.resolve("FAILED_NULL_PDU")
                        }
                        else -> {
                            TraceLog.d("SmsModulePromiseResolve", mapOf("sentAction" to intent.action, "result" to "FAILED_UNKNOWN_CODE_$resultCode"))
                            promise.resolve("FAILED_UNKNOWN_CODE_$resultCode")
                        }
                    }
                }
            }

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                TraceLog.d("SmsModuleRegisterReceiverBefore", mapOf("sentAction" to sentAction, "mode" to "NOT_EXPORTED"))
                context.registerReceiver(
                    receiver, IntentFilter(sentAction), Context.RECEIVER_NOT_EXPORTED,
                )
            } else {
                @Suppress("UnspecifiedRegisterReceiverFlag")
                TraceLog.d("SmsModuleRegisterReceiverBefore", mapOf("sentAction" to sentAction, "mode" to "LEGACY"))
                context.registerReceiver(receiver, IntentFilter(sentAction))
            }
            TraceLog.d("SmsModuleRegisterReceiverAfter", mapOf("sentAction" to sentAction))

            // Long messages get split automatically; we track only the
            // final part's result, which reflects overall send success.
            val parts = smsManager.divideMessage(message)
            TraceLog.d("SmsModuleMessageDivided", mapOf("sentAction" to sentAction, "parts" to parts.size))
            if (parts.size > 1) {
                val sentIntents = ArrayList<PendingIntent>()
                for (i in parts.indices) {
                    sentIntents.add(sentPendingIntent)
                }
                TraceLog.d("SmsModuleSendMultipartBefore", mapOf("sentAction" to sentAction, "parts" to parts.size))
                smsManager.sendMultipartTextMessage(
                    phoneNumber, null, parts, sentIntents, null,
                )
                TraceLog.d("SmsModuleSendMultipartAfter", mapOf("sentAction" to sentAction, "parts" to parts.size))
            } else {
                TraceLog.d("SmsModuleSendTextBefore", mapOf("sentAction" to sentAction))
                smsManager.sendTextMessage(
                    phoneNumber, null, message, sentPendingIntent, null,
                )
                TraceLog.d("SmsModuleSendTextAfter", mapOf("sentAction" to sentAction))
            }
        } catch (error: Exception) {
            TraceLog.e("SmsModuleSendSmsException", error, mapOf("phoneNumber" to phoneNumber))
            promise.resolve("FAILED_EXCEPTION_${error.message ?: "UNKNOWN"}")
        }
    }
}
