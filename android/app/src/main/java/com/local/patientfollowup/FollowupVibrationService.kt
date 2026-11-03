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
import android.os.PowerManager
import android.os.VibrationAttributes
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat

/**
 * Starts directly from an AlarmManager PendingIntent.getForegroundService.
 * Unlike a broadcast-then-service handoff, the OS grants the alarm's
 * foreground execution allowance to the component that plays the haptics.
 * Five seconds maximum; neither a persistent process nor background polling.
 */
class FollowupVibrationService : Service() {
  companion object {
    private const val TAG = "FollowupVibration"
    private const val CHANNEL_ID = "followup-vibration-active-v1"
    private const val NOTIFICATION_ID = 27114
    private const val REQUEST_STOP = 27115
    private const val REQUEST_OPEN = 27116
    private const val MAX_VIBRATION_MS = 5_000L
    const val ACTION_STOP = "com.local.patientfollowup.STOP_VIBRATION"
  }

  private val handler = Handler(Looper.getMainLooper())
  private val stopRunnable = Runnable { stopSelf() }
  private var vibrator: Vibrator? = null
  private var wakeLock: PowerManager.WakeLock? = null

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_STOP) {
      stopSelf()
      return START_NOT_STICKY
    }
    val isTestAlarm = intent?.action == ACTION_TEST_ALARM
    val isRealAlarm = intent?.action == ACTION_FOLLOWUP_ALARM
    try {
      ensureServiceChannel()
      val stopIntent = Intent(this, FollowupVibrationService::class.java).setAction(ACTION_STOP)
      val stopPendingIntent = PendingIntent.getService(
        this, REQUEST_STOP, stopIntent,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )
      val openIntent = Intent(this, MainActivity::class.java).apply {
        action = Intent.ACTION_VIEW
        data = Uri.parse("patientfollowup://followups")
        this.flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
      }
      val openPendingIntent = PendingIntent.getActivity(
        this, REQUEST_OPEN, openIntent,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )
      val foregroundNotification = NotificationCompat.Builder(this, CHANNEL_ID)
        .setSmallIcon(android.R.drawable.ic_lock_idle_alarm)
        .setContentTitle("研伴随访提醒")
        .setContentText("本次震动最多持续 5 秒，点此查看待办。")
        .setContentIntent(openPendingIntent)
        .setOngoing(true)
        .setCategory(NotificationCompat.CATEGORY_ALARM)
        .setPriority(NotificationCompat.PRIORITY_LOW)
        .addAction(android.R.drawable.ic_media_pause, "停止震动", stopPendingIntent)
        .build()

      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
        startForeground(
          NOTIFICATION_ID, foregroundNotification,
          ServiceInfo.FOREGROUND_SERVICE_TYPE_SYSTEM_EXEMPTED,
        )
      } else {
        startForeground(NOTIFICATION_ID, foregroundNotification)
      }

      // Post the actual high-importance, persistent reminder here. It remains in
      // the shade after this short-lived foreground service has stopped.
      if (isTestAlarm) {
        LocalFollowupAlarm.deliverTestReminder(this, {}, inService = true)
      } else if (isRealAlarm) {
        LocalFollowupAlarm.deliverAndContinue(this, {}, inService = true)
      }

      val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      val channel = manager.getNotificationChannel(FOLLOWUP_CHANNEL_ID)
      val vibrationAllowed = NotificationManagerCompat.from(this).areNotificationsEnabled() &&
        channel != null && channel.importance != NotificationManager.IMPORTANCE_NONE &&
        channel.shouldVibrate()
      if (!vibrationAllowed) {
        if (isTestAlarm) setTestError("系统通知或当前提醒渠道的震动未开启")
        stopSelf()
        return START_NOT_STICKY
      }

      val powerManager = getSystemService(Context.POWER_SERVICE) as PowerManager
      // Ensures the CPU stays awake for the 5-second haptic when the screen is off.
      wakeLock = powerManager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Yanban:AlarmHaptics").apply {
        acquire(MAX_VIBRATION_MS + 1_000L)
      }
      if (playVibration() && isTestAlarm) {
        getSharedPreferences(REMINDER_PREFS, Context.MODE_PRIVATE)
          .edit().putLong(KEY_TEST_VIBRATION_AT, System.currentTimeMillis())
          .remove(KEY_TEST_ERROR).apply()
      }
      handler.removeCallbacks(stopRunnable)
      handler.postDelayed(stopRunnable, MAX_VIBRATION_MS)
    } catch (error: Throwable) {
      Log.e(TAG, "Alarm foreground execution or vibration failed", error)
      if (isTestAlarm) setTestError(error.javaClass.simpleName + ": " + (error.message ?: "未知错误"))
      // A denied foreground-service type must not silently swallow the alarm.
      try {
        if (isTestAlarm) LocalFollowupAlarm.deliverTestReminder(this, {}, inService = true)
        else if (isRealAlarm) LocalFollowupAlarm.deliverAndContinue(this, {}, inService = true)
      } catch (fallbackError: Throwable) {
        Log.e(TAG, "Unable to publish the fallback reminder notification", fallbackError)
      }
      stopSelf()
    }
    return START_NOT_STICKY
  }

  private fun setTestError(message: String) {
    getSharedPreferences(REMINDER_PREFS, Context.MODE_PRIVATE)
      .edit().putString(KEY_TEST_ERROR, message.take(220)).apply()
  }

  private fun playVibration(): Boolean {
    val device = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      (getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as VibratorManager).defaultVibrator
    } else {
      @Suppress("DEPRECATION")
      (getSystemService(Context.VIBRATOR_SERVICE) as Vibrator)
    }
    if (!device.hasVibrator()) {
      setTestError("该设备没有可用的震动马达")
      return false
    }
    vibrator = device
    // Short repeated alarm haptic; the service always cancels at 5 seconds.
    val effect = VibrationEffect.createWaveform(longArrayOf(0, 600, 250, 600, 350), 0)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      device.vibrate(effect, VibrationAttributes.createForUsage(VibrationAttributes.USAGE_ALARM))
    } else {
      @Suppress("DEPRECATION")
      device.vibrate(effect, AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_ALARM)
        .build())
    }
    return true
  }

  private fun ensureServiceChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (manager.getNotificationChannel(CHANNEL_ID) != null) return
    manager.createNotificationChannel(NotificationChannel(
      CHANNEL_ID, "正在执行的随访震动", NotificationManager.IMPORTANCE_LOW,
    ).apply {
      setSound(null, null)
      enableVibration(false)
      description = "仅在随访闹钟的五秒震动期间显示"
    })
  }

  override fun onDestroy() {
    handler.removeCallbacks(stopRunnable)
    vibrator?.cancel()
    vibrator = null
    try {
      wakeLock?.let { if (it.isHeld) it.release() }
    } catch (error: Throwable) {
      Log.w(TAG, "Unable to release haptics wakelock", error)
    }
    wakeLock = null
    super.onDestroy()
  }
}
