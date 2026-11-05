package com.local.patientfollowup

import android.Manifest
import android.content.ContentUris
import android.content.ContentValues
import android.content.Context
import android.content.pm.PackageManager
import android.provider.CalendarContract
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.WritableArray
import com.facebook.react.bridge.WritableMap
import org.json.JSONObject
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.LocalTime
import java.time.ZoneId
import java.util.TimeZone

/**
 * Optional, explicitly authorized Android Calendar Provider integration.
 * Patient names, phone numbers, diagnoses, counts, and internal task IDs
 * NEVER leave the encrypted app database.
 *
 * One neutral event per due date; the calendar app, not Yanban, delivers its
 * own system reminder. We only delete events whose IDs we created and own.
 */
internal object FollowupCalendarSync {
  private const val PREFS = "yanban_calendar_reminder_v1"
  private const val KEY_ENABLED = "enabled"
  private const val KEY_CALENDAR_ID = "calendar_id"
  private const val KEY_EVENTS = "events"
  private const val EVENT_TITLE = "研伴 · 今日随访提醒"
  private const val EVENT_DESCRIPTION = "今天有随访任务，请打开研伴查看。"
  private const val EVENT_MARKER = "YANBAN_FOLLOWUP_REMINDER_V1"

  private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
  private fun allowed(context: Context): Boolean =
    ContextCompat.checkSelfPermission(context, Manifest.permission.READ_CALENDAR) == PackageManager.PERMISSION_GRANTED &&
      ContextCompat.checkSelfPermission(context, Manifest.permission.WRITE_CALENDAR) == PackageManager.PERMISSION_GRANTED

  fun status(context: Context): WritableMap {
    val p = prefs(context)
    return Arguments.createMap().apply {
      putBoolean("enabled", p.getBoolean(KEY_ENABLED, false))
      putString("calendarId", p.getString(KEY_CALENDAR_ID, null))
      putBoolean("permissionGranted", allowed(context))
      putInt("syncedDates", JSONObject(p.getString(KEY_EVENTS, "{}") ?: "{}").length())
    }
  }

  fun listCalendars(context: Context): WritableArray {
    if (!allowed(context)) throw SecurityException("请先允许研伴读取和写入日历。")
    val result = Arguments.createArray()
    val projection = arrayOf(
      CalendarContract.Calendars._ID,
      CalendarContract.Calendars.CALENDAR_DISPLAY_NAME,
      CalendarContract.Calendars.ACCOUNT_NAME,
      CalendarContract.Calendars.CALENDAR_ACCESS_LEVEL,
      CalendarContract.Calendars.VISIBLE,
    )
    context.contentResolver.query(CalendarContract.Calendars.CONTENT_URI, projection, null, null, null)?.use { cursor ->
      while (cursor.moveToNext()) {
        val access = cursor.getInt(3)
        if (access < CalendarContract.Calendars.CAL_ACCESS_CONTRIBUTOR || cursor.getInt(4) == 0) continue
        result.pushMap(Arguments.createMap().apply {
          putString("id", cursor.getLong(0).toString())
          putString("name", cursor.getString(1) ?: "日历")
          putString("account", cursor.getString(2) ?: "")
        })
      }
    }
    return result
  }

  private fun isWritable(context: Context, calendarId: Long): Boolean {
    val projection = arrayOf(CalendarContract.Calendars.CALENDAR_ACCESS_LEVEL)
    context.contentResolver.query(
      CalendarContract.Calendars.CONTENT_URI, projection,
      "${CalendarContract.Calendars._ID} = ? AND ${CalendarContract.Calendars.VISIBLE} = 1",
      arrayOf(calendarId.toString()), null,
    )?.use { cursor ->
      if (cursor.moveToFirst()) return cursor.getInt(0) >= CalendarContract.Calendars.CAL_ACCESS_CONTRIBUTOR
    }
    return false
  }

  fun configure(context: Context, calendarIdText: String?, enabled: Boolean): WritableMap {
    if (enabled) {
      if (!allowed(context)) throw SecurityException("需要日历读写权限才能开启提醒。")
      val id = calendarIdText?.toLongOrNull() ?: throw IllegalArgumentException("请选择一个可写日历。")
      if (!isWritable(context, id)) throw IllegalArgumentException("所选日历不可写，请重新选择。")
      val p = prefs(context)
      val oldId = p.getString(KEY_CALENDAR_ID, null)
      if (p.getBoolean(KEY_ENABLED, false) && oldId != null && oldId != calendarIdText) {
        removeAllOwned(context, JSONObject(p.getString(KEY_EVENTS, "{}") ?: "{}"))
        p.edit().putString(KEY_EVENTS, "{}").commit()
      }
      p.edit().putBoolean(KEY_ENABLED, true).putString(KEY_CALENDAR_ID, calendarIdText).commit()
    } else {
      val p = prefs(context)
      if (allowed(context)) {
        removeAllOwned(context, JSONObject(p.getString(KEY_EVENTS, "{}") ?: "{}"))
        p.edit().putString(KEY_EVENTS, "{}").commit()
      }
      p.edit().putBoolean(KEY_ENABLED, false).commit()
    }
    return status(context)
  }

  private fun isOwned(context: Context, id: Long): Boolean {
    context.contentResolver.query(
      ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI, id),
      arrayOf(CalendarContract.Events.DESCRIPTION), null, null, null,
    )?.use { cursor ->
      if (cursor.moveToFirst()) return (cursor.getString(0) ?: "").contains(EVENT_MARKER)
    }
    return false
  }

  private fun removeOwned(context: Context, id: Long) {
    if (isOwned(context, id)) {
      context.contentResolver.delete(ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI, id), null, null)
    }
  }

  private fun removeAllOwned(context: Context, mapping: JSONObject) {
    for (key in mapping.keys()) {
      val id = mapping.optLong(key, -1L)
      if (id > 0) removeOwned(context, id)
    }
  }

  private fun insert(context: Context, calendarId: Long, day: LocalDate): Long {
    val zone = ZoneId.systemDefault()
    val startAt = LocalDateTime.of(day, LocalTime.of(9, 0)).atZone(zone).toInstant().toEpochMilli()
    val values = ContentValues().apply {
      put(CalendarContract.Events.CALENDAR_ID, calendarId)
      put(CalendarContract.Events.TITLE, EVENT_TITLE)
      put(CalendarContract.Events.DESCRIPTION, EVENT_DESCRIPTION + "\n" + EVENT_MARKER)
      put(CalendarContract.Events.DTSTART, startAt)
      put(CalendarContract.Events.DTEND, startAt + 15 * 60_000L)
      put(CalendarContract.Events.EVENT_TIMEZONE, TimeZone.getDefault().id)
      put(CalendarContract.Events.HAS_ALARM, 1)
    }
    val uri = context.contentResolver.insert(CalendarContract.Events.CONTENT_URI, values)
      ?: throw IllegalStateException("日历未能保存随访日程。")
    val eventId = ContentUris.parseId(uri)
    try {
      val reminder = ContentValues().apply {
        put(CalendarContract.Reminders.EVENT_ID, eventId)
        put(CalendarContract.Reminders.MINUTES, 0)
        put(CalendarContract.Reminders.METHOD, CalendarContract.Reminders.METHOD_ALERT)
      }
      context.contentResolver.insert(CalendarContract.Reminders.CONTENT_URI, reminder)
        ?: throw IllegalStateException("系统日历不支持该日程提醒。")
    } catch (error: Exception) {
      context.contentResolver.delete(uri, null, null)
      throw error
    }
    return eventId
  }

  /**
   * Idempotently reconcile each upcoming scheduled date; do not create
   * retroactive reminders for overdue dates. Current-day 9 AM event is only
   * created if its time is still in the future.
   */
  fun sync(context: Context, dateKeys: List<String>): WritableMap {
    val p = prefs(context)
    if (!p.getBoolean(KEY_ENABLED, false)) return status(context)
    if (!allowed(context)) throw SecurityException("日历权限已被关闭，请重新授权。")
    val calendarId = p.getString(KEY_CALENDAR_ID, null)?.toLongOrNull()
      ?: throw IllegalStateException("尚未选择目标日历。")
    if (!isWritable(context, calendarId)) throw IllegalStateException("目标日历已不可写，请重新选择。")

    val now = System.currentTimeMillis()
    val zone = ZoneId.systemDefault()
    val desired = dateKeys.asSequence().map { LocalDate.parse(it) }
      .filter { LocalDateTime.of(it, LocalTime.of(9, 0)).atZone(zone).toInstant().toEpochMilli() > now }
      .map { it.toString() }.toSet()
    val saved = JSONObject(p.getString(KEY_EVENTS, "{}") ?: "{}")
    val next = JSONObject()
    for (key in saved.keys()) {
      val id = saved.optLong(key, -1)
      if (id > 0 && key in desired && isOwned(context, id)) next.put(key, id)
      else if (id > 0 && key !in desired) removeOwned(context, id)
    }
    // Persist incrementally: failed writes can be retried without duplicated dates.
    p.edit().putString(KEY_EVENTS, next.toString()).commit()
    for (key in desired.sorted()) {
      if (next.has(key)) continue
      val id = insert(context, calendarId, LocalDate.parse(key))
      next.put(key, id)
      p.edit().putString(KEY_EVENTS, next.toString()).commit()
    }
    return status(context)
  }
}
