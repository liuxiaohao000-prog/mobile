package com.local.patientfollowup

import android.Manifest
import android.content.ContentUris
import android.content.ContentValues
import android.content.Context
import android.content.Intent
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
  private const val KEY_TEST_EVENT = "test_event"
  private const val TEST_TITLE = "研伴 · 日历响铃测试"
  private val REMINDER_TIMES = listOf(LocalTime.of(9, 30), LocalTime.of(19, 0))

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
      val map = JSONObject(p.getString(KEY_EVENTS, "{}") ?: "{}")
      putInt("syncedDates", map.keys().asSequence().map { it.substringBefore("@") }.toSet().size)
      putInt("syncedEvents", map.length())
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
      CalendarContract.Calendars.ACCOUNT_TYPE,
    )
    context.contentResolver.query(CalendarContract.Calendars.CONTENT_URI, projection, null, null, null)?.use { cursor ->
      while (cursor.moveToNext()) {
        val access = cursor.getInt(3)
        // VISIBLE is a display preference, not a calendar write permission.
        if (access < CalendarContract.Calendars.CAL_ACCESS_CONTRIBUTOR) continue
        val display = cursor.getString(1) ?: "日历"
        val account = cursor.getString(2) ?: ""
        val accountType = cursor.getString(5) ?: ""
        val special = Regex("birthday|anniversary|countdown|生日|纪念日|倒数|boss直聘", RegexOption.IGNORE_CASE)
          .containsMatchIn(display + " " + account)
        val local = accountType == CalendarContract.ACCOUNT_TYPE_LOCAL ||
          account.equals("local account", ignoreCase = true) ||
          (accountType.isBlank() && display.contains("local", ignoreCase = true))
        result.pushMap(Arguments.createMap().apply {
          putString("id", cursor.getLong(0).toString())
          putString("name", display)
          putString("account", account)
          putBoolean("isLocal", local)
          putBoolean("isSpecial", special)
        })
      }
    }
    return result
  }

  private fun isWritable(context: Context, calendarId: Long): Boolean {
    val projection = arrayOf(CalendarContract.Calendars.CALENDAR_ACCESS_LEVEL)
    context.contentResolver.query(
      CalendarContract.Calendars.CONTENT_URI, projection,
      "${CalendarContract.Calendars._ID} = ?",
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

  // Check the event ID recorded by Yanban, as well as the owning calendar,
  // fixed title/description and expected local event date/time. Never search
  // by title to determine deletion candidates: user-created copies are safe.
  private fun isOwned(context: Context, id: Long, expectedCalendar: Long? = null,
    expectedDate: String? = null, expectedTime: LocalTime? = null): Boolean {
    val projection = arrayOf(CalendarContract.Events.TITLE,
      CalendarContract.Events.DESCRIPTION, CalendarContract.Events.CALENDAR_ID,
      CalendarContract.Events.DTSTART)
    context.contentResolver.query(
      ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI, id),
      projection, null, null, null,
    )?.use { cursor ->
      if (!cursor.moveToFirst()) return false
      val title = cursor.getString(0) ?: ""
      val description = cursor.getString(1) ?: ""
      val calendar = cursor.getLong(2)
      val startAt = cursor.getLong(3)
      if (title != EVENT_TITLE) return false
      if (description != EVENT_DESCRIPTION &&
        description != EVENT_DESCRIPTION + "\n" + EVENT_MARKER) return false
      if (expectedCalendar != null && calendar != expectedCalendar) return false
      if (expectedDate != null || expectedTime != null) {
        val instant = java.time.Instant.ofEpochMilli(startAt).atZone(ZoneId.systemDefault())
        if (expectedDate != null && instant.toLocalDate().toString() != expectedDate) return false
        if (expectedTime != null && instant.toLocalTime().withSecond(0).withNano(0) != expectedTime) return false
      }
      return true
    }
    return false
  }

  private fun removeLegacyMarker(context: Context, id: Long) {
    if (!isOwned(context, id)) return
    val values = ContentValues().apply {
      put(CalendarContract.Events.DESCRIPTION, EVENT_DESCRIPTION)
    }
    context.contentResolver.update(
      ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI, id), values, null, null,
    )
  }

  private fun removeOwned(context: Context, id: Long, expectedCalendar: Long? = null,
    expectedDate: String? = null, expectedTime: LocalTime? = null): Boolean {
    if (!isOwned(context, id, expectedCalendar, expectedDate, expectedTime)) return false
    return context.contentResolver.delete(
      ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI, id), null, null) > 0
  }

  private fun removeAllOwned(context: Context, mapping: JSONObject, calendarId: Long? = null) {
    for (key in mapping.keys()) {
      val id = mapping.optLong(key, -1L)
      if (id <= 0) continue
      val day = key.substringBefore("@")
      val time = key.substringAfter("@", "")
      val slot = if (time.isBlank()) LocalTime.of(9, 0) else LocalTime.parse(time)
      removeOwned(context, id, calendarId, day, slot)
    }
  }

  private fun insert(context: Context, calendarId: Long, day: LocalDate, time: LocalTime): Long {
    val zone = ZoneId.systemDefault()
    val startAt = LocalDateTime.of(day, time).atZone(zone).toInstant().toEpochMilli()
    val values = ContentValues().apply {
      put(CalendarContract.Events.CALENDAR_ID, calendarId)
      put(CalendarContract.Events.TITLE, EVENT_TITLE)
      put(CalendarContract.Events.DESCRIPTION, EVENT_DESCRIPTION)
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

  fun openNextReminder(context: Context): Boolean {
    val mapping = JSONObject(prefs(context).getString(KEY_EVENTS, "{}") ?: "{}")
    val candidates = mutableListOf<Pair<String, Long>>()
    for (key in mapping.keys()) {
      val id = mapping.optLong(key, -1L)
      if (id > 0 && isOwned(context, id)) candidates.add(key to id)
    }
    val chosen = candidates.minByOrNull { it.first } ?: return false
    context.startActivity(Intent(Intent.ACTION_VIEW).apply {
      data = ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI, chosen.second)
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    })
    return true
  }

  // METHOD_ALERT schedules a standard calendar notification; OPPO's separate
  // "响铃提醒" switch is owned by the calendar app and cannot be forced here.
  fun createTestEvent(context: Context): Long {
    if (!allowed(context)) throw SecurityException("请先允许研伴访问日历。")
    val p = prefs(context)
    val calendarId = p.getString(KEY_CALENDAR_ID, null)?.toLongOrNull()
      ?: throw IllegalStateException("请先选择一个日历。")
    if (!isWritable(context, calendarId)) throw IllegalStateException("所选日历不可写。")
    val previous = p.getLong(KEY_TEST_EVENT, -1L)
    if (previous > 0) {
      context.contentResolver.query(ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI, previous),
        arrayOf(CalendarContract.Events.TITLE), null, null, null)?.use { cursor ->
        if (cursor.moveToFirst() && cursor.getString(0) == TEST_TITLE) {
          context.contentResolver.delete(
            ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI, previous), null, null)
        }
      }
    }
    val startAt = System.currentTimeMillis() + 2 * 60_000L
    val values = ContentValues().apply {
      put(CalendarContract.Events.CALENDAR_ID, calendarId)
      put(CalendarContract.Events.TITLE, TEST_TITLE)
      put(CalendarContract.Events.DESCRIPTION, "请观察手机日历是否响铃。测试后可在日历中删除。")
      put(CalendarContract.Events.DTSTART, startAt)
      put(CalendarContract.Events.DTEND, startAt + 5 * 60_000L)
      put(CalendarContract.Events.EVENT_TIMEZONE, TimeZone.getDefault().id)
      put(CalendarContract.Events.HAS_ALARM, 1)
    }
    val uri = context.contentResolver.insert(CalendarContract.Events.CONTENT_URI, values)
      ?: throw IllegalStateException("手机日历无法创建测试日程。")
    val id = ContentUris.parseId(uri)
    try {
      val reminder = ContentValues().apply {
        put(CalendarContract.Reminders.EVENT_ID, id)
        put(CalendarContract.Reminders.MINUTES, 0)
        put(CalendarContract.Reminders.METHOD, CalendarContract.Reminders.METHOD_ALERT)
      }
      context.contentResolver.insert(CalendarContract.Reminders.CONTENT_URI, reminder)
        ?: throw IllegalStateException("此日历不支持标准提醒。")
    } catch (error: Exception) {
      context.contentResolver.delete(uri, null, null)
      throw error
    }
    p.edit().putLong(KEY_TEST_EVENT, id).commit()
    return id
  }

  fun openTestEvent(context: Context): Boolean {
    val id = prefs(context).getLong(KEY_TEST_EVENT, -1L)
    if (id <= 0) return false
    context.startActivity(Intent(Intent.ACTION_VIEW).apply {
      data = ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI, id)
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    })
    return true
  }

  /**
   * A single reconciler for enrollment, exit, completion and foreground
   * repair. Keys: yyyy-MM-dd@HH:mm. V2.0.14 keys (yyyy-MM-dd) refer to the
   * legacy 09:00 slot and are deleted only after ownership verification.
   *
   * Persist every successful operation. Fail closed if an owned event can't
   * be verified; never delete an unrelated event based on its title alone.
   */
  @Synchronized
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
      .flatMap { day -> REMINDER_TIMES.asSequence().map { time ->
        day.toString() + "@" + time.toString() to
          LocalDateTime.of(day, time).atZone(zone).toInstant().toEpochMilli()
      }}
      .filter { it.second > now }.map { it.first }.toSet()

    val mapping = JSONObject(p.getString(KEY_EVENTS, "{}") ?: "{}")
    fun persist() { p.edit().putString(KEY_EVENTS, mapping.toString()).commit() }
    // Work only from the private ID registry. Existing 09:00 events are
    // migrated, including days which now require two new slots.
    for (key in mapping.keys().asSequence().toList()) {
      val id = mapping.optLong(key, -1L)
      val day = key.substringBefore("@")
      val timeText = key.substringAfter("@", "")
      val time = if (timeText.isEmpty()) LocalTime.of(9, 0) else LocalTime.parse(timeText)
      if (id <= 0) {
        mapping.remove(key)
        persist()
        continue
      }
      if (key in desired) {
        if (isOwned(context, id, calendarId, day, time)) {
          removeLegacyMarker(context, id)
          continue
        }
        // A missing or manually modified event is not safe to delete.
        // Leave a modified event alone and replace only the correct slot.
        mapping.remove(key)
        persist()
        continue
      }
      if (removeOwned(context, id, calendarId, day, time)) {
        mapping.remove(key)
        persist()
      } else {
        // If it is already absent, remove its stale reference. If it exists
        // but ownership can't be proven, retain it for manual reconciliation.
        val exists = context.contentResolver.query(
          ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI, id),
          arrayOf(CalendarContract.Events._ID), null, null, null)?.use { it.moveToFirst() } ?: false
        if (!exists) {
          mapping.remove(key)
          persist()
        }
      }
    }
    for (key in desired.sorted()) {
      if (mapping.has(key)) continue
      val day = LocalDate.parse(key.substringBefore("@"))
      val time = LocalTime.parse(key.substringAfter("@"))
      val id = insert(context, calendarId, day, time)
      mapping.put(key, id)
      persist()
    }
    return status(context)
  }
}
