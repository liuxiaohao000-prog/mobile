package com.local.patientfollowup

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log
import android.widget.RemoteViews
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.facebook.react.ReactPackage
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.uimanager.ViewManager
import org.json.JSONObject
import java.time.LocalDate
import java.time.ZoneId

internal const val MONITOR_PREFS = "followup_monitor_state"
private const val KEY_ENABLED = "enabled"
private const val KEY_PENDING_DATES = "pending_dates_json"
private const val KEY_COMPLETED_DATES = "completed_dates_json"
private const val KEY_TOTAL_PATIENTS = "total_enrolled"
private const val KEY_LAST_ERROR = "last_error"
private const val KEY_LAST_STARTED_AT = "last_started_at"
private const val KEY_LAST_STOPPED_AT = "last_stopped_at"
private const val KEY_LAST_RESTART_REASON = "last_restart_reason"
private const val KEY_START_COUNT = "start_count"
private const val KEY_LAST_TASK_REMOVED_AT = "last_task_removed_at"
private const val KEY_LAST_RESTORE_ATTEMPT_AT = "last_restore_attempt_at"

class FollowupMonitorPackage : ReactPackage {
  override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> =
    listOf(FollowupMonitorModule(reactContext))

  override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> =
    emptyList()
}

class FollowupMonitorModule(
  private val context: ReactApplicationContext,
) : ReactContextBaseJavaModule(context) {
  override fun getName(): String = "FollowupMonitor"

  @ReactMethod
  fun getMonitorStatus(promise: Promise) {
    try {
      val prefs = context.getSharedPreferences(MONITOR_PREFS, Context.MODE_PRIVATE)
      val result = Arguments.createMap().apply {
        putBoolean("enabled", prefs.getBoolean(KEY_ENABLED, false))
        putBoolean("running", FollowupMonitorService.running)
        putString("lastError", prefs.getString(KEY_LAST_ERROR, "") ?: "")
        putDouble("lastStartedAt", prefs.getLong(KEY_LAST_STARTED_AT, 0L).toDouble())
        putDouble("lastStoppedAt", prefs.getLong(KEY_LAST_STOPPED_AT, 0L).toDouble())
        putString("lastStartReason", prefs.getString(KEY_LAST_RESTART_REASON, "") ?: "")
        putInt("startCount", prefs.getInt(KEY_START_COUNT, 0))
        putDouble("lastTaskRemovedAt", prefs.getLong(KEY_LAST_TASK_REMOVED_AT, 0L).toDouble())
        putDouble("lastRestoreAttemptAt", prefs.getLong(KEY_LAST_RESTORE_ATTEMPT_AT, 0L).toDouble())
      }
      promise.resolve(result)
    } catch (e: Throwable) {
      promise.reject("MONITOR_STATUS_FAILED", e.message ?: "无法读取后台监测状态", e)
    }
  }

  @ReactMethod
  fun setMonitorEnabled(enabled: Boolean, promise: Promise) {
    try {
      val prefs = context.getSharedPreferences(MONITOR_PREFS, Context.MODE_PRIVATE)
      if (enabled && !NotificationManagerCompat.from(context).areNotificationsEnabled()) {
        throw IllegalStateException("请先允许研伴发送系统通知，才能开启常驻监测。")
      }
      prefs.edit().putBoolean(KEY_ENABLED, enabled).remove(KEY_LAST_ERROR).commit()
      if (enabled) {
        try {
          ContextCompat.startForegroundService(
            context,
            Intent(context, FollowupMonitorService::class.java).setAction(FollowupMonitorService.ACTION_START),
          )
        } catch (error: Throwable) {
          prefs.edit().putBoolean(KEY_ENABLED, false)
            .putString(KEY_LAST_ERROR, error.message ?: "系统限制后台监测").commit()
          throw error
        }
      } else {
        prefs.edit().putString(KEY_LAST_RESTART_REASON, "用户关闭后台监测").apply()
        context.stopService(Intent(context, FollowupMonitorService::class.java))
        (context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager)
          .cancel(FollowupMonitorService.NOTIFICATION_ID)
      }
      promise.resolve(true)
    } catch (error: Throwable) {
      promise.reject("MONITOR_CONTROL_FAILED", error.message ?: "设置后台监测失败", error)
    }
  }

  @ReactMethod
  fun updateMonitorSnapshot(pendingJson: String, completedJson: String, totalPatients: Int, promise: Promise) {
    try {
      // Validate the aggregated anonymous date histogram before persisting it.
      JSONObject(pendingJson)
      JSONObject(completedJson)
      val prefs = context.getSharedPreferences(MONITOR_PREFS, Context.MODE_PRIVATE)
      val normalizedTotal = totalPatients.coerceAtLeast(0)
      val changed = prefs.getString(KEY_PENDING_DATES, null) != pendingJson ||
        prefs.getString(KEY_COMPLETED_DATES, null) != completedJson ||
        prefs.getInt(KEY_TOTAL_PATIENTS, -1) != normalizedTotal
      if (changed) {
        prefs.edit().putString(KEY_PENDING_DATES, pendingJson)
          .putString(KEY_COMPLETED_DATES, completedJson)
          .putInt(KEY_TOTAL_PATIENTS, normalizedTotal).apply()
        // Only redraw on changes, never on periodic heartbeat.
        FollowupMonitorService.refreshVisibleNotification(context)
      }
      promise.resolve(true)
    } catch (error: Throwable) {
      promise.reject("MONITOR_SNAPSHOT_FAILED", error.message ?: "更新后台统计失败", error)
    }
  }

  @ReactMethod
  fun restoreMonitorIfEnabled(promise: Promise) {
    try {
      val prefs = context.getSharedPreferences(MONITOR_PREFS, Context.MODE_PRIVATE)
      if (prefs.getBoolean(KEY_ENABLED, false) && !FollowupMonitorService.running &&
        NotificationManagerCompat.from(context).areNotificationsEnabled()) {
        ContextCompat.startForegroundService(
          context,
          Intent(context, FollowupMonitorService::class.java).setAction(FollowupMonitorService.ACTION_START),
        )
      }
      promise.resolve(true)
    } catch (error: Throwable) {
      context.getSharedPreferences(MONITOR_PREFS, Context.MODE_PRIVATE)
        .edit().putString(KEY_LAST_ERROR, error.message ?: "无法恢复后台监测").apply()
      promise.resolve(false)
    }
  }
}

/**
 * User-initiated, visible monitoring foreground service.
 *
 * No polling, GPS, network I/O, WakeLock, database access or JS engine loop.
 * Only an aggregated local date histogram is cached; no patient identifiers.
 * The existing independent AlarmManager alarms remain responsible for alerting.
 */
class FollowupMonitorService : Service() {
  companion object {
    const val ACTION_START = "com.local.patientfollowup.MONITOR_START"
    const val ACTION_STOP = "com.local.patientfollowup.MONITOR_STOP"
    const val NOTIFICATION_ID = 27160
    private const val CHANNEL_ID = "followup-background-monitor-v1"
    private const val STOP_REQUEST_CODE = 27161
    private const val OPEN_REQUEST_CODE = 27162
    @Volatile var running: Boolean = false
      private set

    /**
     * Restore only after a system-supported lifecycle event (boot or package
     * upgrade), and only for users who previously enabled this visible service.
     * No periodic alarms, timers or hidden resurrection after Force Stop.
     */
    fun restoreAfterSystemEvent(context: Context, action: String) {
      val prefs = context.getSharedPreferences(MONITOR_PREFS, Context.MODE_PRIVATE)
      if (!prefs.getBoolean(KEY_ENABLED, false) ||
        !NotificationManagerCompat.from(context).areNotificationsEnabled()) return
      prefs.edit().putLong(KEY_LAST_RESTORE_ATTEMPT_AT, System.currentTimeMillis())
        .putString(KEY_LAST_RESTART_REASON, "系统事件：$action").apply()
      try {
        ContextCompat.startForegroundService(
          context,
          Intent(context, FollowupMonitorService::class.java).setAction(ACTION_START),
        )
      } catch (error: Throwable) {
        Log.w("FollowupMonitor", "System-event foreground restart denied", error)
        prefs.edit().putString(KEY_LAST_ERROR,
          "系统事件恢复失败：" + (error.message ?: error.javaClass.simpleName)).apply()
      }
    }

    fun refreshVisibleNotification(context: Context) {
      if (!running) return
      try {
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        manager.notify(NOTIFICATION_ID, createNotification(context))
      } catch (error: Throwable) {
        Log.w("FollowupMonitor", "Cannot update ongoing summary", error)
      }
    }

    private fun countForDay(json: String?, today: LocalDate, pending: Boolean): Int {
      if (json.isNullOrEmpty()) return 0
      val map = JSONObject(json)
      var count = 0
      val iter = map.keys()
      while (iter.hasNext()) {
        val key = iter.next()
        val date = try { LocalDate.parse(key) } catch (_: Throwable) { null }
        if (date != null && (if (pending) !date.isAfter(today) else date == today)) {
          count += map.optInt(key, 0).coerceAtLeast(0)
        }
      }
      return count
    }

    private fun createNotification(context: Context): android.app.Notification {
      val prefs = context.getSharedPreferences(MONITOR_PREFS, Context.MODE_PRIVATE)
      val today = LocalDate.now()
      val pending = countForDay(prefs.getString(KEY_PENDING_DATES, "{}"), today, true)
      val completed = countForDay(prefs.getString(KEY_COMPLETED_DATES, "{}"), today, false)
      val enrolled = prefs.getInt(KEY_TOTAL_PATIENTS, 0)
      val openIntent = Intent(context, MainActivity::class.java).apply {
        action = Intent.ACTION_VIEW
        data = Uri.parse("patientfollowup://home")
        flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
      }
      val open = PendingIntent.getActivity(context, OPEN_REQUEST_CODE, openIntent,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
      val stop = PendingIntent.getService(context, STOP_REQUEST_CODE,
        Intent(context, FollowupMonitorService::class.java).setAction(ACTION_STOP),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)

      val compact = RemoteViews(context.packageName, R.layout.yanban_monitor_compact).apply {
        setTextViewText(R.id.yanban_monitor_compact_counts,
          "待随访 $pending   ·   已完成 $completed   ·   总入组 $enrolled")
      }
      val expanded = RemoteViews(context.packageName, R.layout.yanban_monitor_expanded).apply {
        setTextViewText(R.id.yanban_monitor_due, pending.toString())
        setTextViewText(R.id.yanban_monitor_completed, completed.toString())
        setTextViewText(R.id.yanban_monitor_enrolled, enrolled.toString())
      }
      return NotificationCompat.Builder(context, CHANNEL_ID)
        .setSmallIcon(R.drawable.ic_yanban_monitor_notification)
        .setContentTitle("研伴 · 随访监测中")
        .setContentText("待随访 $pending · 今日完成 $completed · 总入组 $enrolled")
        .setStyle(NotificationCompat.DecoratedCustomViewStyle())
        .setCustomContentView(compact)
        .setCustomBigContentView(expanded)
        .setContentIntent(open)
        .setCategory(NotificationCompat.CATEGORY_SERVICE)
        .setPriority(NotificationCompat.PRIORITY_LOW)
        .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
        .setOnlyAlertOnce(true)
        .setSilent(true)
        .setOngoing(true)
        .setShowWhen(false)
        .addAction(android.R.drawable.ic_media_pause, "结束监测", stop)
        .build()
    }
  }

  private val handler = Handler(Looper.getMainLooper())
  private val midnightRefresh = Runnable {
    refreshVisibleNotification(this)
    scheduleNextDayRefresh()
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val prefs = getSharedPreferences(MONITOR_PREFS, Context.MODE_PRIVATE)
    if (intent?.action == ACTION_STOP) {
      prefs.edit().putBoolean(KEY_ENABLED, false)
        .putString(KEY_LAST_RESTART_REASON, "用户从通知栏停止").apply()
      stopSelf()
      return START_NOT_STICKY
    }
    if (!prefs.getBoolean(KEY_ENABLED, false)) {
      stopSelf()
      return START_NOT_STICKY
    }
    try {
      ensureChannel()
      val notification = createNotification(this)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
        startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
      } else {
        startForeground(NOTIFICATION_ID, notification)
      }
      running = true
      val starts = prefs.getInt(KEY_START_COUNT, 0) + 1
      val reason = when {
        intent == null -> "系统恢复前台服务"
        intent.action == ACTION_START && starts > 1 -> "用户启动或系统事件恢复"
        else -> "用户开启后台监测"
      }
      prefs.edit().putLong(KEY_LAST_STARTED_AT, System.currentTimeMillis())
        .putInt(KEY_START_COUNT, starts)
        .putString(KEY_LAST_RESTART_REASON, reason)
        .remove(KEY_LAST_ERROR).apply()
      scheduleNextDayRefresh()
    } catch (error: Throwable) {
      Log.e("FollowupMonitor", "User-enabled FGS could not start", error)
      prefs.edit().putBoolean(KEY_ENABLED, false)
        .putString(KEY_LAST_ERROR, error.javaClass.simpleName + ": " + (error.message ?: "")).apply()
      stopSelf()
      return START_NOT_STICKY
    }
    // Android can restart a sticky foreground service after process eviction.
    // User Force Stop / OEM force-kill still overrides this.
    return START_STICKY
  }

  private fun ensureChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (manager.getNotificationChannel(CHANNEL_ID) != null) return
    val channel = NotificationChannel(
      CHANNEL_ID, "随访后台监测", NotificationManager.IMPORTANCE_LOW,
    ).apply {
      setSound(null, null)
      enableVibration(false)
      setShowBadge(false)
      description = "可选的低功耗常驻监测，展示汇总数量，不含患者个人信息"
    }
    manager.createNotificationChannel(channel)
  }

  private fun scheduleNextDayRefresh() {
    handler.removeCallbacks(midnightRefresh)
    val now = System.currentTimeMillis()
    val midnight = LocalDate.now().plusDays(1).atStartOfDay(ZoneId.systemDefault())
      .toInstant().toEpochMilli()
    // No WakeLock: when the device sleeps, next-day counters can update after
    // the process becomes runnable. Actual reminders use AlarmManager separately.
    handler.postDelayed(midnightRefresh, (midnight - now).coerceAtLeast(1_000L))
  }

  override fun onTaskRemoved(rootIntent: Intent?) {
    // stopWithTask=false means task removal must not stop the monitoring service.
    // Record it for diagnostics; do not spin up a new background service here.
    getSharedPreferences(MONITOR_PREFS, Context.MODE_PRIVATE).edit()
      .putLong(KEY_LAST_TASK_REMOVED_AT, System.currentTimeMillis()).apply()
    Log.i("FollowupMonitor", "Recent-task removal observed; keeping user-enabled FGS")
    super.onTaskRemoved(rootIntent)
  }

  override fun onDestroy() {
    running = false
    handler.removeCallbacks(midnightRefresh)
    getSharedPreferences(MONITOR_PREFS, Context.MODE_PRIVATE).edit()
      .putLong(KEY_LAST_STOPPED_AT, System.currentTimeMillis()).apply()
    super.onDestroy()
  }
}
