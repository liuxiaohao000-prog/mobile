package com.local.patientfollowup

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.AudioAttributes
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.VibrationAttributes
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.util.Log
import androidx.core.app.NotificationCompat

/**
 * A bounded foreground execution context for user-visible alarm vibration.
 *
 * Only launch from an exact alarm (or an in-app test). Android 14+ permits the
 * systemExempted FGS type for an app eligible to use exact alarms. If a device
 * denies this service, the ordinary notification remains as the fallback.
 *
 * Never persist patient identity or medical details in notifications.
 */
class FollowupVibrationService : Service() {
  companion object {
    private const val TAG = "FollowupVibration"
    private const val CHANNEL_ID = "followup-vibration-active-v1"
    private const val NOTIFICATION_ID = 27114
    private const val REQUEST_STOP = 27115
    private const val REQUEST_OPEN = 27116
    private const val MAX_VIBRATION_MS = 20_000L
    const val ACTION_STOP = "com.local.patientfollowup.STOP_VIBRATION"
  }

  private val handler = Handler(Looper.getMainLooper())
  private val stopRunnable = Runnable { stopSelf() }
  private var vibrator: Vibrator? = null

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_STOP) {
      stopSelf()
      return START_NOT_STICKY
    }
    try {
      ensureServiceChannel()
      val stopIntent = Intent(this, FollowupVibrationService::class.java)
        .setAction(ACTION_STOP)
      val stopPendingIntent = PendingIntent.getService(
        this, REQUEST_STOP, stopIntent,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )
      val openIntent = Intent(this, MainActivity::class.java).apply {
        action = Intent.ACTION_VIEW
        data = Uri.parse("patientfollowup://followups")
        flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
      }
      val openPendingIntent = PendingIntent.getActivity(
        this, REQUEST_OPEN, openIntent,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )
      val notification = NotificationCompat.Builder(this, CHANNEL_ID)
        .setSmallIcon(android.R.drawable.ic_lock_idle_alarm)
        .setContentTitle("研伴随访提醒")
        .setContentText("提醒震动中；点此打开待办，或停止本次震动。")
        .setContentIntent(openPendingIntent)
        .setOngoing(true)
        .setCategory(NotificationCompat.CATEGORY_ALARM)
        .setPriority(NotificationCompat.PRIORITY_LOW)
        .addAction(android.R.drawable.ic_media_pause, "停止本次震动", stopPendingIntent)
        .build()

      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        startForeground(
          NOTIFICATION_ID,
          notification,
          ServiceInfo.FOREGROUND_SERVICE_TYPE_SYSTEM_EXEMPTED,
        )
      } else {
        startForeground(NOTIFICATION_ID, notification)
      }
      handler.removeCallbacks(stopRunnable)
      playVibration()
      handler.postDelayed(stopRunnable, MAX_VIBRATION_MS)
    } catch (error: Throwable) {
      Log.w(TAG, "Alarm vibration unavailable; standard reminder remains active", error)
      stopSelf()
    }
    return START_NOT_STICKY
  }

  private fun playVibration() {
    val device = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      (getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as VibratorManager).defaultVibrator
    } else {
      @Suppress("DEPRECATION")
      (getSystemService(Context.VIBRATOR_SERVICE) as Vibrator)
    }
    if (!device.hasVibrator()) return

    vibrator = device
    // Repeats until the user stops it or the hard 20-second safety limit.
    // Designed to be recognizable without locking the screen or bypassing DND.
    val pattern = longArrayOf(0, 650, 320, 650, 900)
    val effect = VibrationEffect.createWaveform(pattern, 0)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      device.vibrate(effect, VibrationAttributes.createForUsage(VibrationAttributes.USAGE_ALARM))
    } else {
      @Suppress("DEPRECATION")
      device.vibrate(effect, AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_ALARM)
        .build())
    }
  }

  private fun ensureServiceChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (manager.getNotificationChannel(CHANNEL_ID) != null) return
    val channel = NotificationChannel(
      CHANNEL_ID,
      "正在执行的随访震动",
      NotificationManager.IMPORTANCE_LOW,
    ).apply {
      setSound(null, null)
      enableVibration(false)
      description = "仅在随访闹钟震动期间显示，可随时停止。"
    }
    manager.createNotificationChannel(channel)
  }

  override fun onDestroy() {
    handler.removeCallbacks(stopRunnable)
    vibrator?.cancel()
    vibrator = null
    super.onDestroy()
  }
}
