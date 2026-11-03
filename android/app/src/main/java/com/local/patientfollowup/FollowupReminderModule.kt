package com.local.patientfollowup

import android.app.AlarmManager
import android.app.ActivityManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.os.VibrationAttributes
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.provider.Settings
import android.util.Log
import androidx.core.app.AlarmManagerCompat
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.facebook.react.ReactPackage
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.uimanager.ViewManager
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.ZoneId
import java.util.concurrent.atomic.AtomicBoolean

internal const val REMINDER_PREFS = "patient_followup_reminder"
private const val KEY_EARLIEST_OPEN_DATE = "earliest_open_date"
private const val KEY_TEST_SCHEDULED_AT = "test_scheduled_at"
internal const val KEY_TEST_TRIGGERED_AT = "test_triggered_at"
internal const val KEY_TEST_NOTIFIED_AT = "test_notified_at"
internal const val KEY_TEST_VIBRATION_AT = "test_vibration_at"
internal const val KEY_TEST_ERROR = "test_error"
internal const val KEY_TEST_RECEIVED_AT = "test_receiver_received_at"
internal const val ACTION_FOLLOWUP_ALARM = "com.local.patientfollowup.FOLLOWUP_ALARM"
internal const val ACTION_TEST_ALARM = "com.local.patientfollowup.TEST_ALARM"
internal const val FOLLOWUP_CHANNEL_ID = "followup-reminders-v4"
private const val ALARM_REQUEST_CODE = 27110
private const val NOTIFICATION_ID = 27111
private const val TEST_ALARM_REQUEST_CODE = 27112
private const val TEST_NOTIFICATION_ID = 27113

class FollowupReminderPackage : ReactPackage {
  override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> =
    listOf(FollowupReminderModule(reactContext))

  override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> =
    emptyList()
}

class FollowupReminderModule(
  private val reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule(reactContext) {
  override fun getName(): String = "FollowupReminder"

  @ReactMethod
  fun prepareNotificationChannel(promise: Promise) {
    try {
      LocalFollowupAlarm.ensureNotificationChannel(reactContext)
      promise.resolve(true)
    } catch (error: Throwable) {
      promise.reject("FOLLOWUP_CHANNEL_FAILED", error.message ?: "无法设置通知渠道。", error)
    }
  }

  @ReactMethod
  fun getReminderDiagnostics(promise: Promise) {
    try {
      LocalFollowupAlarm.ensureNotificationChannel(reactContext)
      val preferences = reactContext.getSharedPreferences(REMINDER_PREFS, Context.MODE_PRIVATE)
      val manager = reactContext.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      val channel = manager.getNotificationChannel(FOLLOWUP_CHANNEL_ID)
      val activityManager = reactContext.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
      val result = Arguments.createMap().apply {
        putDouble("testScheduledAt", preferences.getLong(KEY_TEST_SCHEDULED_AT, 0L).toDouble())
        putDouble("testTriggeredAt", preferences.getLong(KEY_TEST_TRIGGERED_AT, 0L).toDouble())
        putBoolean("highImportance", channel != null && channel.importance >= NotificationManager.IMPORTANCE_HIGH)
        putBoolean("vibrationEnabled", channel?.shouldVibrate() ?: false)
        putBoolean("backgroundRestricted", activityManager.isBackgroundRestricted)
        putBoolean("notificationsEnabled", NotificationManagerCompat.from(reactContext).areNotificationsEnabled())
        putBoolean("exactAlarmAllowed", Build.VERSION.SDK_INT < Build.VERSION_CODES.S ||
          (reactContext.getSystemService(Context.ALARM_SERVICE) as AlarmManager).canScheduleExactAlarms())
        putDouble("testNotificationPostedAt", preferences.getLong(KEY_TEST_NOTIFIED_AT, 0L).toDouble())
        putDouble("testReceiverReceivedAt", preferences.getLong(KEY_TEST_RECEIVED_AT, 0L).toDouble())
        putDouble("testVibrationStartedAt", preferences.getLong(KEY_TEST_VIBRATION_AT, 0L).toDouble())
        putString("testError", preferences.getString(KEY_TEST_ERROR, "") ?: "")
        putDouble("channelImportance", (channel?.importance ?: 0).toDouble())
        putBoolean("batteryOptimizationExempt", (reactContext.getSystemService(Context.POWER_SERVICE) as PowerManager)
          .isIgnoringBatteryOptimizations(reactContext.packageName))
      }
      promise.resolve(result)
    } catch (error: Throwable) {
      promise.reject("FOLLOWUP_DIAGNOSTICS_FAILED", error.message ?: "无法读取提醒状态。", error)
    }
  }

  @ReactMethod
  fun syncReminderDate(earliestOpenDate: String?, forceReschedule: Boolean, promise: Promise) {
    try {
      LocalFollowupAlarm.sync(reactContext, earliestOpenDate, forceReschedule)
      promise.resolve(true)
    } catch (error: Throwable) {
      promise.reject("FOLLOWUP_ALARM_SYNC_FAILED", error.message ?: "无法更新本地随访闹钟。", error)
    }
  }

  @ReactMethod
  fun sendTestNotificationNow(promise: Promise) {
    try {
      promise.resolve(LocalFollowupAlarm.postTestReminder(reactContext))
    } catch (error: Throwable) {
      promise.reject("FOLLOWUP_TEST_NOTIFICATION_FAILED", error.message ?: "无法发送测试通知。", error)
    }
  }

  @ReactMethod
  fun scheduleTestNotificationInOneMinute(promise: Promise) {
    try {
      promise.resolve(LocalFollowupAlarm.scheduleTestReminder(reactContext))
    } catch (error: Throwable) {
      promise.reject("FOLLOWUP_TEST_ALARM_FAILED", error.message ?: "无法安排测试提醒。", error)
    }
  }

  @ReactMethod
  fun openNotificationChannelSettings(promise: Promise) {
    try {
      val intent = Intent(Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS).apply {
        putExtra(Settings.EXTRA_APP_PACKAGE, reactContext.packageName)
        putExtra(Settings.EXTRA_CHANNEL_ID, FOLLOWUP_CHANNEL_ID)
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      }
      reactContext.startActivity(intent)
      promise.resolve(true)
    } catch (error: Throwable) {
      promise.reject("FOLLOWUP_CHANNEL_SETTINGS_FAILED", error.message ?: "无法打开通知设置。", error)
    }
  }

  @ReactMethod
  fun openAppNotificationSettings(promise: Promise) {
    try {
      val intent = Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).apply {
        putExtra(Settings.EXTRA_APP_PACKAGE, reactContext.packageName)
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      }
      reactContext.startActivity(intent)
      promise.resolve(true)
    } catch (error: Throwable) {
      promise.reject("FOLLOWUP_APP_SETTINGS_FAILED", error.message ?: "无法打开应用通知设置。", error)
    }
  }
}

class FollowupReminderReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent?) {
    val action = intent?.action
    if (action !in setOf(
        ACTION_FOLLOWUP_ALARM, ACTION_TEST_ALARM, Intent.ACTION_BOOT_COMPLETED,
        Intent.ACTION_MY_PACKAGE_REPLACED, Intent.ACTION_TIME_CHANGED,
        Intent.ACTION_TIMEZONE_CHANGED,
        AlarmManager.ACTION_SCHEDULE_EXACT_ALARM_PERMISSION_STATE_CHANGED,
      )) return
    val pending = goAsync()
    val finished = AtomicBoolean(false)
    val finish = { if (finished.compareAndSet(false, true)) pending.finish() }
    try {
      when (action) {
        ACTION_TEST_ALARM -> {
          // A short broadcast is the primary OS alarm target: post the notification
          // BEFORE doing any optional haptic work, avoiding all-or-nothing FGS delivery.
          val scheduled = context.getSharedPreferences(REMINDER_PREFS, Context.MODE_PRIVATE)
            .getLong(KEY_TEST_SCHEDULED_AT, 0L)
          val received = System.currentTimeMillis()
          context.getSharedPreferences(REMINDER_PREFS, Context.MODE_PRIVATE).edit()
            .putLong(KEY_TEST_RECEIVED_AT, received).commit()
          Log.i("FollowupReminder", "Test alarm receiver entered; latenessMs=" +
            (if (scheduled > 0L) (received - scheduled) else -1L))
          val shouldVibrate = LocalFollowupAlarm.deliverTestReminder(context, {}, inService = true)
          if (shouldVibrate) LocalFollowupAlarm.playReceiverHaptics(context, true, finish)
          else finish()
        }
        ACTION_FOLLOWUP_ALARM -> {
          val shouldVibrate = LocalFollowupAlarm.deliverAndContinue(context, {}, inService = true)
          if (shouldVibrate) LocalFollowupAlarm.playReceiverHaptics(context, false, finish)
          else finish()
        }
        // Reboot, timezone changes and package updates must only re-arm the
        // next alarm. They must not create a surprise notification at 2 AM.
        else -> {
          LocalFollowupAlarm.scheduleFromSavedState(context)
          finish()
        }
      }
    } catch (error: Throwable) {
      Log.e("FollowupReminder", "Unable to deliver or reschedule reminder", error)
      finish()
    }
  }
}

internal object LocalFollowupAlarm {
  // Ordinary notification vibration follows the notification-channel setting.
  // Sustained, bounded alarm haptics are owned by FollowupVibrationService.
  private val reminderVibrationPattern = longArrayOf(0, 300, 180, 300)

  fun sync(context: Context, earliestOpenDate: String?, forceReschedule: Boolean) {
    val normalizedDate = earliestOpenDate?.also { LocalDate.parse(it) }
    val preferences = context.getSharedPreferences(REMINDER_PREFS, Context.MODE_PRIVATE)
    val previousDate = preferences.getString(KEY_EARLIEST_OPEN_DATE, null)
    if (!forceReschedule && previousDate == normalizedDate) return

    preferences.edit().apply {
      if (normalizedDate == null) remove(KEY_EARLIEST_OPEN_DATE)
      else putString(KEY_EARLIEST_OPEN_DATE, normalizedDate)
    }.apply()
    scheduleFromSavedState(context)
  }

  fun deliverAndContinue(context: Context, onFinished: () -> Unit, inService: Boolean = false): Boolean {
    val earliestOpenDate = context.getSharedPreferences(REMINDER_PREFS, Context.MODE_PRIVATE)
      .getString(KEY_EARLIEST_OPEN_DATE, null)
      ?: run { onFinished(); return false }
    val dueDate = LocalDate.parse(earliestOpenDate)
    val today = LocalDate.now()
    val reminderTimePassed = !java.time.LocalTime.now().isBefore(java.time.LocalTime.of(9, 0))
    var vibrationAllowed = false
    try {
      if (dueDate.isBefore(today) || (dueDate == today && reminderTimePassed)) {
        // Do not lose today's notification if scheduling tomorrow's alarm fails.
        vibrationAllowed = postReminder(context, {}, inService)
      }
    } finally {
      try {
        scheduleFromSavedState(context)
      } catch (error: Throwable) {
        Log.e("FollowupReminder", "Could not schedule next day reminder", error)
      }
      onFinished()
    }
    return vibrationAllowed
  }

  fun scheduleFromSavedState(context: Context) {
    ensureNotificationChannel(context)
    val preferences = context.getSharedPreferences(REMINDER_PREFS, Context.MODE_PRIVATE)
    val earliestOpenDate = preferences.getString(KEY_EARLIEST_OPEN_DATE, null)
    val alarmManager = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
    val exactAllowed = Build.VERSION.SDK_INT < Build.VERSION_CODES.S || alarmManager.canScheduleExactAlarms()
    val foregroundOperation = alarmPendingIntent(context, true)
    val receiverOperation = alarmPendingIntent(context, false)
    alarmManager.cancel(foregroundOperation)
    alarmManager.cancel(receiverOperation)
    if (earliestOpenDate == null) {
      foregroundOperation.cancel()
      receiverOperation.cancel()
      return
    }

    val earliestDate = LocalDate.parse(earliestOpenDate)
    val today = LocalDate.now()
    val candidateDate = if (earliestDate.isAfter(today)) earliestDate else today
    val zone = ZoneId.systemDefault()
    val nowMillis = System.currentTimeMillis()
    var triggerAtMillis = LocalDateTime.of(candidateDate, java.time.LocalTime.of(9, 0))
      .atZone(zone)
      .toInstant()
      .toEpochMilli()
    if (triggerAtMillis <= nowMillis) {
      triggerAtMillis = LocalDateTime.of(today.plusDays(1), java.time.LocalTime.of(9, 0))
        .atZone(zone)
        .toInstant()
        .toEpochMilli()
    }

    if (exactAllowed) {
      val showIntent = context.packageManager.getLaunchIntentForPackage(context.packageName)?.let {
        PendingIntent.getActivity(
          context,
          ALARM_REQUEST_CODE,
          it,
          PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
      }
      alarmManager.setAlarmClock(AlarmManager.AlarmClockInfo(triggerAtMillis, showIntent), receiverOperation)
    } else {
      AlarmManagerCompat.setAndAllowWhileIdle(alarmManager, AlarmManager.RTC_WAKEUP, triggerAtMillis, receiverOperation)
    }
  }

  private fun alarmPendingIntent(context: Context, foreground: Boolean): PendingIntent {
    val intent = if (foreground) Intent(context, FollowupVibrationService::class.java)
    else Intent(context, FollowupReminderReceiver::class.java)
    intent.action = ACTION_FOLLOWUP_ALARM
    val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    return if (foreground) PendingIntent.getForegroundService(context, ALARM_REQUEST_CODE, intent, flags)
    else PendingIntent.getBroadcast(context, ALARM_REQUEST_CODE, intent, flags)
  }

  private fun postReminder(context: Context, onFinished: () -> Unit, inService: Boolean = false): Boolean {
    // Production and test reminders use the same notification and vibration path.
    return postNotification(
      context,
      NOTIFICATION_ID,
      "患者随访提醒",
      "请打开研伴查看尚未完成的电话随访任务。",
      onFinished,
      inService,
    )
  }

  fun postTestReminder(context: Context, onFinished: (() -> Unit)? = null, inService: Boolean = false): Boolean = postNotification(
    context,
    TEST_NOTIFICATION_ID,
    "随访提醒测试",
    "这是一条系统闹钟触发的测试通知。请观察横幅和震动。",
    onFinished,
    inService,
  )

  fun deliverTestReminder(context: Context, onFinished: () -> Unit, inService: Boolean = false): Boolean {
    context.getSharedPreferences(REMINDER_PREFS, Context.MODE_PRIVATE)
      .edit().putLong(KEY_TEST_TRIGGERED_AT, System.currentTimeMillis()).commit()
    return postTestReminder(context, onFinished, inService)
  }

  fun scheduleTestReminder(context: Context): Boolean {
    ensureNotificationChannel(context)
    val alarmManager = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
    val operation = testAlarmPendingIntent(context, false)
    val legacyOperation = testAlarmPendingIntent(context, true)
    alarmManager.cancel(operation)
    alarmManager.cancel(legacyOperation)
    val exactAlarmAllowed = Build.VERSION.SDK_INT < Build.VERSION_CODES.S || alarmManager.canScheduleExactAlarms()
    if (!exactAlarmAllowed) {
      throw IllegalStateException("请先为研伴开启系统「闹钟和提醒」权限，再执行一分钟准点测试。")
    }
    val triggerAtMillis = System.currentTimeMillis() + 60_000L
    if (exactAlarmAllowed) {
      val showIntent = context.packageManager.getLaunchIntentForPackage(context.packageName)?.let {
        PendingIntent.getActivity(
          context,
          TEST_ALARM_REQUEST_CODE,
          it,
          PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
      }
      alarmManager.setAlarmClock(AlarmManager.AlarmClockInfo(triggerAtMillis, showIntent), operation)
    }
    context.getSharedPreferences(REMINDER_PREFS, Context.MODE_PRIVATE).edit()
      .putLong(KEY_TEST_SCHEDULED_AT, triggerAtMillis)
      .remove(KEY_TEST_TRIGGERED_AT)
      .remove(KEY_TEST_RECEIVED_AT)
      .remove(KEY_TEST_NOTIFIED_AT)
      .remove(KEY_TEST_VIBRATION_AT)
      .remove(KEY_TEST_ERROR)
      .commit()
    return true
  }

  private fun postNotification(
    context: Context,
    notificationId: Int,
    title: String,
    body: String,
    onFinished: (() -> Unit)? = null,
    inService: Boolean = false,
  ): Boolean {
    ensureNotificationChannel(context)
    if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) {
      onFinished?.invoke()
      return false
    }

    val clickIntent = Intent(context, MainActivity::class.java).apply {
      action = Intent.ACTION_VIEW
      data = Uri.parse("patientfollowup://followups")
      flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
    }
    val clickPendingIntent = PendingIntent.getActivity(
      context,
      notificationId,
      clickIntent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
    val notification = NotificationCompat.Builder(context, FOLLOWUP_CHANNEL_ID)
      .setSmallIcon(android.R.drawable.ic_menu_my_calendar)
      .setContentTitle(title)
      .setContentText(body)
      .setCategory(NotificationCompat.CATEGORY_ALARM)
      .setPriority(NotificationCompat.PRIORITY_MAX)
      .setContentIntent(clickPendingIntent)
      .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
      .setAutoCancel(true)
      .setOnlyAlertOnce(false)
      .setVibrate(reminderVibrationPattern)
      .build()

    val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    val channel = manager.getNotificationChannel(FOLLOWUP_CHANNEL_ID)
    val vibrationEnabled = channel?.shouldVibrate() ?: false
    if (channel == null || channel.importance == NotificationManager.IMPORTANCE_NONE) {
      onFinished?.invoke()
      return false
    }
    try {
      // A fresh notification can alert again when yesterday's reminder is still in the shade.
      manager.cancel(notificationId)
      manager.notify(notificationId, notification)
      if (notificationId == TEST_NOTIFICATION_ID) {
        context.getSharedPreferences(REMINDER_PREFS, Context.MODE_PRIVATE).edit()
          .putLong(KEY_TEST_NOTIFIED_AT, System.currentTimeMillis()).apply()
      }
    } catch (_: SecurityException) {
      // The OS may revoke notification permission while the scheduled alarm remains.
      onFinished?.invoke()
      return false
    }
    // Do not keep the BroadcastReceiver alive via Handler.postDelayed:
    // a receiver is not a reliable place to play long haptics under Doze.
    // A real alarm is allowed to start a short, user-dismissible foreground
    // service if the app currently holds its exact-alarm permission.
    if (!inService && vibrationEnabled && (Build.VERSION.SDK_INT < Build.VERSION_CODES.S ||
        (context.getSystemService(Context.ALARM_SERVICE) as AlarmManager).canScheduleExactAlarms())) {
      try {
        androidx.core.content.ContextCompat.startForegroundService(
          context,
          Intent(context, FollowupVibrationService::class.java),
        )
      } catch (error: Throwable) {
        // The notification was already published; do not lose the reminder
        // if a manufacturer forbids the optional foreground service.
        Log.w("FollowupReminder", "Extended vibration unavailable; delivered notification only", error)
      }
    }
    onFinished?.invoke()
    return vibrationEnabled
  }

  /**
   * Called directly inside the alarm BroadcastReceiver, after publishing the
   * high-importance notification. Native one-shot haptics are handed to the
   * Android vibrator service and do not depend on creating a foreground service.
   * Keep a bounded async receiver and CPU wake lock while the haptic finishes.
   */
  fun playReceiverHaptics(context: Context, isTest: Boolean, onFinished: () -> Unit) {
    val prefs = context.getSharedPreferences(REMINDER_PREFS, Context.MODE_PRIVATE)
    var wakeLock: PowerManager.WakeLock? = null
    try {
      val vibrator = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        (context.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as VibratorManager).defaultVibrator
      } else {
        @Suppress("DEPRECATION")
        (context.getSystemService(Context.VIBRATOR_SERVICE) as Vibrator)
      }
      if (!vibrator.hasVibrator()) {
        if (isTest) prefs.edit().putString(KEY_TEST_ERROR, "该手机没有可用震动马达").apply()
        onFinished()
        return
      }
      val power = context.getSystemService(Context.POWER_SERVICE) as PowerManager
      wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Yanban:ReceiverHaptics").apply {
        acquire(7_000L)
      }
      val effect = VibrationEffect.createWaveform(
        longArrayOf(0, 900, 125, 900, 125, 900, 125, 900, 125, 1_000), -1)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        vibrator.vibrate(effect, VibrationAttributes.createForUsage(VibrationAttributes.USAGE_ALARM))
      } else {
        vibrator.vibrate(effect, AudioAttributes.Builder()
          .setUsage(AudioAttributes.USAGE_ALARM).build())
      }
      if (isTest) {
        prefs.edit().putLong(KEY_TEST_VIBRATION_AT, System.currentTimeMillis())
          .remove(KEY_TEST_ERROR).apply()
      }
      val held = wakeLock ?: throw IllegalStateException("WakeLock creation failed")
      Handler(Looper.getMainLooper()).postDelayed({
        try {
          if (held.isHeld) held.release()
        } finally {
          onFinished()
        }
      }, 5_200L)
    } catch (error: Throwable) {
      Log.e("FollowupReminder", "Could not play receiver vibration", error)
      if (isTest) prefs.edit()
        .putString(KEY_TEST_ERROR, (error.javaClass.simpleName + ": " + (error.message ?: "震动失败")).take(220))
        .apply()
      try { wakeLock?.let { if (it.isHeld) it.release() } } catch (_: Throwable) {}
      onFinished()
    }
  }

  private fun testAlarmPendingIntent(context: Context, foreground: Boolean): PendingIntent {
    val intent = if (foreground) Intent(context, FollowupVibrationService::class.java)
    else Intent(context, FollowupReminderReceiver::class.java)
    intent.action = ACTION_TEST_ALARM
    val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    return if (foreground) PendingIntent.getForegroundService(context, TEST_ALARM_REQUEST_CODE, intent, flags)
    else PendingIntent.getBroadcast(context, TEST_ALARM_REQUEST_CODE, intent, flags)
  }

  fun ensureNotificationChannel(context: Context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (manager.getNotificationChannel(FOLLOWUP_CHANNEL_ID) != null) return

    val channel = NotificationChannel(
      FOLLOWUP_CHANNEL_ID,
      "患者随访提醒",
      NotificationManager.IMPORTANCE_HIGH,
    ).apply {
      setVibrationPattern(reminderVibrationPattern)
      enableVibration(true)
      lockscreenVisibility = android.app.Notification.VISIBILITY_PUBLIC
      description = "重要随访提醒。横幅显示取决于系统通知和勿扰设置。"
      setSound(
        RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION),
        AudioAttributes.Builder()
          .setUsage(AudioAttributes.USAGE_NOTIFICATION_EVENT)
          .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
          .build(),
      )
    }
    manager.createNotificationChannel(channel)
  }
}
