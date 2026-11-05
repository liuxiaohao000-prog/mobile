package com.local.patientfollowup

import android.app.AlarmManager
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.uimanager.ViewManager

/**
 * Calendar-only follow-up reminder bridge.
 * No native alarms, test notifications, vibration or battery exemptions.
 * The brief background-monitor notification has its own independent service.
 */
class FollowupReminderPackage : ReactPackage {
  override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> =
    listOf(FollowupReminderModule(reactContext))

  override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> =
    emptyList()
}

class FollowupReminderModule(
  private val context: ReactApplicationContext,
) : ReactContextBaseJavaModule(context) {
  override fun getName(): String = "FollowupReminder"

  @ReactMethod
  fun getCalendarReminderStatus(promise: Promise) {
    try { promise.resolve(FollowupCalendarSync.status(context)) }
    catch (error: Throwable) { promise.reject("CALENDAR_STATUS_FAILED", error.message, error) }
  }

  @ReactMethod
  fun listWritableCalendars(promise: Promise) {
    try { promise.resolve(FollowupCalendarSync.listCalendars(context)) }
    catch (error: Throwable) { promise.reject("CALENDAR_LIST_FAILED", error.message, error) }
  }

  @ReactMethod
  fun configureCalendarReminders(calendarId: String?, enabled: Boolean, promise: Promise) {
    try { promise.resolve(FollowupCalendarSync.configure(context, calendarId, enabled)) }
    catch (error: Throwable) { promise.reject("CALENDAR_CONFIG_FAILED", error.message, error) }
  }

  @ReactMethod
  fun syncCalendarReminderDates(dates: ReadableArray, promise: Promise) {
    try {
      val keys = (0 until dates.size()).mapNotNull { dates.getString(it) }
      promise.resolve(FollowupCalendarSync.sync(context, keys))
    } catch (error: Throwable) { promise.reject("CALENDAR_SYNC_FAILED", error.message, error) }
  }

  @ReactMethod
  fun openNextCalendarReminder(promise: Promise) {
    try { promise.resolve(FollowupCalendarSync.openNextReminder(context)) }
    catch (error: Throwable) { promise.reject("CALENDAR_OPEN_FAILED", error.message, error) }
  }

  @ReactMethod
  fun createCalendarRingingTest(promise: Promise) {
    try { promise.resolve(FollowupCalendarSync.createTestEvent(context).toString()) }
    catch (error: Throwable) { promise.reject("CALENDAR_TEST_FAILED", error.message, error) }
  }

  @ReactMethod
  fun openCalendarRingingTest(promise: Promise) {
    try { promise.resolve(FollowupCalendarSync.openTestEvent(context)) }
    catch (error: Throwable) { promise.reject("CALENDAR_TEST_OPEN_FAILED", error.message, error) }
  }

  /**
   * Upgrading V2.0.15 can leave PendingIntents and notifications owned by the
   * old alarm component. Cancel them using their exact former class names,
   * request codes and actions before removing alarm-related permissions.
   * Never touch Calendar Provider events or monitoring notifications here.
   */
  @ReactMethod
  fun cleanupLegacyAlarms(promise: Promise) {
    try {
      val manager = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
      val receiver = "com.local.patientfollowup.FollowupReminderReceiver"
      val service = "com.local.patientfollowup.FollowupVibrationService"
      val flags = PendingIntent.FLAG_NO_CREATE or PendingIntent.FLAG_IMMUTABLE
      for ((code, action) in listOf(
        27110 to "com.local.patientfollowup.FOLLOWUP_ALARM",
        27112 to "com.local.patientfollowup.TEST_ALARM",
        27131 to "com.local.patientfollowup.FOLLOWUP_ALARM",
        27132 to "com.local.patientfollowup.TEST_ALARM",
      )) {
        val intent = Intent().setClassName(context.packageName, receiver).setAction(action)
        PendingIntent.getBroadcast(context, code, intent, flags)?.let {
          manager.cancel(it)
          it.cancel()
        }
      }
      for ((code, action) in listOf(
        27110 to "com.local.patientfollowup.FOLLOWUP_ALARM",
        27112 to "com.local.patientfollowup.TEST_ALARM",
      )) {
        val intent = Intent().setClassName(context.packageName, service).setAction(action)
        PendingIntent.getForegroundService(context, code, intent, flags)?.let {
          manager.cancel(it)
          it.cancel()
        }
      }
      val notifications = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      notifications.cancel(27111)
      notifications.cancel(27113)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        notifications.deleteNotificationChannel("followup-reminders-v4")
      }
      context.getSharedPreferences("patient_followup_reminder", Context.MODE_PRIVATE)
        .edit().remove("earliest_open_date").commit()
      promise.resolve(true)
    } catch (error: Throwable) {
      promise.reject("LEGACY_ALARM_CLEANUP_FAILED", error.message, error)
    }
  }
}
