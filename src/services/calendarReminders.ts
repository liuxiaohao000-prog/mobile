import { NativeModules, PermissionsAndroid, Platform } from 'react-native';
import type { FollowupTask } from '../types';

export type WritableCalendar = { id: string; name: string; account: string };
export type CalendarReminderStatus = {
  enabled: boolean;
  calendarId: string | null;
  permissionGranted: boolean;
  syncedDates: number;
};

type CalendarNative = {
  getCalendarReminderStatus: () => Promise<CalendarReminderStatus>;
  listWritableCalendars: () => Promise<WritableCalendar[]>;
  configureCalendarReminders: (id: string | null, enabled: boolean) => Promise<CalendarReminderStatus>;
  syncCalendarReminderDates: (dates: string[]) => Promise<CalendarReminderStatus>;
};

const native = NativeModules.FollowupReminder as CalendarNative | undefined;

function androidCalendar(): CalendarNative {
  if (Platform.OS !== 'android' || !native?.getCalendarReminderStatus) {
    throw new Error('手机日历同步当前仅支持 Android 原生版。');
  }
  return native;
}

export async function calendarReminderStatus(): Promise<CalendarReminderStatus | null> {
  if (Platform.OS !== 'android') return null;
  return androidCalendar().getCalendarReminderStatus();
}

export async function requestCalendarAccess(): Promise<boolean> {
  if (Platform.OS !== 'android') return false;
  const results = await PermissionsAndroid.requestMultiple([
    PermissionsAndroid.PERMISSIONS.READ_CALENDAR,
    PermissionsAndroid.PERMISSIONS.WRITE_CALENDAR,
  ]);
  return results[PermissionsAndroid.PERMISSIONS.READ_CALENDAR] === PermissionsAndroid.RESULTS.GRANTED &&
    results[PermissionsAndroid.PERMISSIONS.WRITE_CALENDAR] === PermissionsAndroid.RESULTS.GRANTED;
}

export async function writableCalendars(): Promise<WritableCalendar[]> {
  return androidCalendar().listWritableCalendars();
}

export async function configureCalendarReminder(calendarId: string | null, enabled: boolean): Promise<CalendarReminderStatus> {
  return androidCalendar().configureCalendarReminders(calendarId, enabled);
}

export async function syncCalendarFollowups(tasks: FollowupTask[]): Promise<CalendarReminderStatus | null> {
  if (Platform.OS !== 'android') return null;
  const status = await androidCalendar().getCalendarReminderStatus();
  if (!status.enabled) return status;
  // Include all pending tasks; Kotlin uses the actual plan date and ignores
  // days whose 09:00 start already passed. Exactly one event per date.
  const dates = Array.from(new Set(tasks
    .filter(task => task.status !== 'COMPLETED' && task.status !== 'CANCELLED')
    .map(task => task.plannedDate))).sort();
  return androidCalendar().syncCalendarReminderDates(dates);
}
