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

class SmsModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "SmsModule"

    @ReactMethod
    fun sendSms(phoneNumber: String, message: String, promise: Promise) {
        try {
            TraceLog.d("SmsModuleSendSmsStart", mapOf("phoneNumber" to phoneNumber, "messageLength" to message.length))
            val context = reactApplicationContext
            val smsManager: SmsManager =
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    context.getSystemService(SmsManager::class.java)
                } else {
                    @Suppress("DEPRECATION")
                    SmsManager.getDefault()
                }

            val sentAction = "SMS_SENT_ACTION_${System.currentTimeMillis()}"
            val sentIntent = Intent(sentAction).apply { setPackage(context.packageName) }
            val pendingIntentFlags =
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE
                } else {
                    PendingIntent.FLAG_UPDATE_CURRENT
                }
            val sentPendingIntent = PendingIntent.getBroadcast(context, 0, sentIntent, pendingIntentFlags)

            val receiver = object : BroadcastReceiver() {
                override fun onReceive(ctx: Context, intent: Intent) {
                    TraceLog.d("SmsModuleCallbackReceived", mapOf("sentAction" to intent.action, "resultCode" to resultCode))
                    try {
                        context.unregisterReceiver(this)
                        TraceLog.d("SmsModuleCallbackReceiverUnregistered", mapOf("sentAction" to intent.action))
                    } catch (_: IllegalArgumentException) {
                        TraceLog.d("SmsModuleCallbackReceiverAlreadyUnregistered", mapOf("sentAction" to intent.action))
                    }
                    when (resultCode) {
                        Activity.RESULT_OK -> promise.resolve("SENT")
                        SmsManager.RESULT_ERROR_GENERIC_FAILURE -> promise.resolve("FAILED_GENERIC_FAILURE")
                        SmsManager.RESULT_ERROR_NO_SERVICE -> promise.resolve("FAILED_NO_SERVICE")
                        SmsManager.RESULT_ERROR_RADIO_OFF -> promise.resolve("FAILED_RADIO_OFF")
                        SmsManager.RESULT_ERROR_NULL_PDU -> promise.resolve("FAILED_NULL_PDU")
                        else -> promise.resolve("FAILED_UNKNOWN_CODE_$resultCode")
                    }
                }
            }

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                context.registerReceiver(receiver, IntentFilter(sentAction), Context.RECEIVER_NOT_EXPORTED)
            } else {
                @Suppress("UnspecifiedRegisterReceiverFlag")
                context.registerReceiver(receiver, IntentFilter(sentAction))
            }

            val parts = smsManager.divideMessage(message)
            if (parts.size > 1) {
                val sentIntents = ArrayList<PendingIntent>()
                for (i in parts.indices) sentIntents.add(sentPendingIntent)
                smsManager.sendMultipartTextMessage(phoneNumber, null, parts, sentIntents, null)
            } else {
                smsManager.sendTextMessage(phoneNumber, null, message, sentPendingIntent, null)
            }
        } catch (error: Exception) {
            TraceLog.e("SmsModuleSendSmsException", error, mapOf("phoneNumber" to phoneNumber))
            promise.resolve("FAILED_EXCEPTION_${error.message ?: "UNKNOWN"}")
        }
    }
}
