import * as Notifications from 'expo-notifications';
import { Linking, NativeModules, Platform } from 'react-native';
import { getTasks } from '../storage/repository';
import { calendarReminderStatus, syncCalendarFollowups } from './calendarReminders';
import { dateKey } from '../domain/dates';

const CHANNEL_ID = 'followup-reminders-v4';
const VIBRATION_PATTERN = [0, 600, 250, 600, 350, 600, 250, 600, 350, 600];
const SCHEDULE_WINDOW_DAYS = 30;
const MAX_SCHEDULED_REMINDERS = 55;
export type ReminderDiagnostics = {
  testScheduledAt: number;
  testFallbackAt: number;
  testFallbackReceivedAt: number;
  dailyPlannedAt: number;
  dailyFallbackAt: number;
  dailyNotifiedAt: number;
  dailyCatchupAt: number;
  testTriggeredAt: number;
  highImportance: boolean;
  vibrationEnabled: boolean;
  backgroundRestricted: boolean;
  notificationsEnabled: boolean;
  exactAlarmAllowed: boolean;
  channelImportance: number;
  channelLockscreenVisibility: number;
  testNotificationPostedAt: number;
  testReceiverReceivedAt: number;
  testServiceEnteredAt: number;
  batteryOptimizationExempt: boolean;
  appStandbyBucket: number;
  testVibrationStartedAt: number;
  testError: string;
};
const followupReminderModule = NativeModules.FollowupReminder as
  | {
      prepareNotificationChannel: () => Promise<boolean>;
      getReminderDiagnostics: () => Promise<ReminderDiagnostics>;
      syncReminderDate: (earliestOpenDate: string | null, forceReschedule: boolean) => Promise<boolean>;
      sendTestNotificationNow: () => Promise<boolean>;
      scheduleTestNotificationInOneMinute: () => Promise<boolean>;
      openNotificationChannelSettings: () => Promise<boolean>;
      openAppNotificationSettings: () => Promise<boolean>;
      requestBatteryOptimizationExemption: () => Promise<boolean>;
      openBatteryOptimizationSettings: () => Promise<boolean>;
      openAppBatterySettings: () => Promise<boolean>;
    }
  | undefined;

export async function configureNotifications(): Promise<void> {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });
  if (Platform.OS === 'android' && followupReminderModule) {
    await followupReminderModule.prepareNotificationChannel();
  } else if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
      name: '患者随访提醒',
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: VIBRATION_PATTERN,
      enableVibrate: true,
      sound: 'default',
    });
  }
}

export async function getReminderDiagnostics(): Promise<ReminderDiagnostics | null> {
  if (Platform.OS !== 'android' || !followupReminderModule) return null;
  return followupReminderModule.getReminderDiagnostics();
}

export async function requestBatteryOptimizationExemption(): Promise<boolean> {
  if (Platform.OS !== 'android' || !followupReminderModule) {
    throw new Error('该授权入口只适用于 Android 原生版。');
  }
  return followupReminderModule.requestBatteryOptimizationExemption();
}

export async function openBatteryOptimizationSettings(): Promise<void> {
  if (Platform.OS !== 'android' || !followupReminderModule) {
    throw new Error('仅 Android 原生版支持系统电池优化设置。');
  }
  await followupReminderModule.openBatteryOptimizationSettings();
}

export async function openAppBatterySettings(): Promise<void> {
  if (Platform.OS !== 'android' || !followupReminderModule) {
    throw new Error('仅 Android 原生版支持应用设置。');
  }
  await followupReminderModule.openAppBatterySettings();
}

export async function requestNotificationPermission(): Promise<boolean> {
  const current = await Notifications.getPermissionsAsync();
  const result = current.granted
    ? current
    : await Notifications.requestPermissionsAsync();
  return Boolean(result.granted);
}

export async function getExactAlarmPermission(): Promise<boolean> {
  if (Platform.OS !== 'android' || Number(Platform.Version) < 31) return true;
  const permission = await Notifications.getExactAlarmPermissionsAsync();
  return Boolean(permission.granted);
}

export async function requestExactAlarmPermission(): Promise<boolean> {
  if (Platform.OS !== 'android' || Number(Platform.Version) < 31) return true;
  const permission = await Notifications.requestExactAlarmPermissionsAsync();
  return Boolean(permission.granted);
}

export async function sendTestNotificationNow(): Promise<boolean> {
  const granted = await requestNotificationPermission();
  if (!granted) throw new Error('请先允许系统通知，再进行通知测试。');
  if (Platform.OS === 'android' && followupReminderModule) {
    return followupReminderModule.sendTestNotificationNow();
  }
  await Notifications.scheduleNotificationAsync({
    content: {
      title: '随访提醒测试',
      body: '这是一条即时测试通知。声音和振动会按手机及通知渠道设置播放。',
      sound: 'default',
      vibrate: VIBRATION_PATTERN,
      data: { kind: 'notification-test', timing: 'immediate' },
    },
    // A null trigger goes to Expo's fallback channel on Android, bypassing
    // the vibration settings configured for the follow-up channel.
    trigger: { channelId: CHANNEL_ID },
  });
  if (Platform.OS === 'android' && Platform.Version >= 26) {
    const channel = await Notifications.getNotificationChannelAsync(CHANNEL_ID);
    return channel?.enableVibrate ?? true;
  }
  return true;
}

export async function scheduleTestNotificationInOneMinute(): Promise<boolean> {
  const granted = await requestNotificationPermission();
  if (!granted) throw new Error('请先允许系统通知，再进行通知测试。');
  // A precise 60-second test must not silently degrade into an indefinite
  // Doze-batched reminder when SCHEDULE_EXACT_ALARM is not granted.
  if (Platform.OS === 'android' && !(await getExactAlarmPermission())) {
    await requestExactAlarmPermission();
    if (!(await getExactAlarmPermission())) {
      throw new Error('请在系统「闹钟和提醒」页面允许研伴，再回到这里重新安排一分钟测试。');
    }
  }
  const scheduled = await Notifications.getAllScheduledNotificationsAsync();
  for (const request of scheduled) {
    if (request.content.data?.kind === 'notification-test') {
      await Notifications.cancelScheduledNotificationAsync(request.identifier);
    }
  }
  if (Platform.OS === 'android' && followupReminderModule) {
    return followupReminderModule.scheduleTestNotificationInOneMinute();
  }
  await Notifications.scheduleNotificationAsync({
    content: {
      title: '随访提醒测试',
      body: '这是一条约 1 分钟后触发的测试通知。',
      sound: 'default',
      vibrate: VIBRATION_PATTERN,
      data: { kind: 'notification-test', timing: 'delayed' },
    },
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.DATE,
      date: new Date(Date.now() + 60_000),
      channelId: CHANNEL_ID,
      ...(Platform.OS === 'android' ? { delivery: 'alarmClock' as const } : {}),
    },
  });
  return true;
}

export async function openNotificationChannelSettings(): Promise<void> {
  if (Platform.OS === 'android' && followupReminderModule) {
    await followupReminderModule.openNotificationChannelSettings();
    return;
  }
  await Linking.openSettings();
}

export async function openAppNotificationSettings(): Promise<void> {
  if (Platform.OS === 'android' && followupReminderModule) {
    await followupReminderModule.openAppNotificationSettings();
    return;
  }
  await Linking.openSettings();
}

export async function refreshLocalReminders(forceReschedule = false): Promise<void> {
  const tasks = await getTasks();
  // Prefer the user's explicitly selected system calendar. Create/reconcile
  // Calendar Provider events BEFORE cancelling legacy alarms, so a calendar
  // failure does not silently leave patients without reminders.
  if (Platform.OS === 'android' && followupReminderModule) {
    const calendar = await calendarReminderStatus();
    if (calendar?.enabled) {
      await syncCalendarFollowups(tasks);
      const scheduled = await Notifications.getAllScheduledNotificationsAsync();
      for (const request of scheduled) {
        if (request.content.data?.kind === 'followup-reminder') {
          await Notifications.cancelScheduledNotificationAsync(request.identifier);
        }
      }
      await followupReminderModule.syncReminderDate(null, true);
      return;
    }
  }
  const liveTasks = tasks.filter(
    (task) => task.status !== 'COMPLETED' && task.status !== 'CANCELLED',
  );
  if (Platform.OS === 'android' && followupReminderModule) {
    const scheduled = await Notifications.getAllScheduledNotificationsAsync();
    for (const request of scheduled) {
      if (request.content.data?.kind === 'followup-reminder') {
        await Notifications.cancelScheduledNotificationAsync(request.identifier);
      }
    }
    const earliestOpenDate = liveTasks.reduce<string | null>(
      (earliest, task) => earliest === null || task.plannedDate < earliest ? task.plannedDate : earliest,
      null,
    );
    await followupReminderModule.syncReminderDate(earliestOpenDate, forceReschedule);
    return;
  }

  const now = new Date();
  const today = dateKey(now);
  const earliestOpenDate = liveTasks.reduce<string | null>(
    (earliest, task) => earliest === null || task.plannedDate < earliest ? task.plannedDate : earliest,
    null,
  );
  const reminderDates = new Set<string>();
  for (let offset = 0; offset <= SCHEDULE_WINDOW_DAYS; offset += 1) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
    const key = dateKey(day);
    if (earliestOpenDate !== null && earliestOpenDate <= key) {
      const atNine = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 9, 0, 0, 0);
      if (atNine.getTime() > now.getTime()) reminderDates.add(key);
    }
  }

  for (const task of liveTasks) {
    if (task.plannedDate > today) {
      const dueAt = new Date(task.plannedDate + 'T09:00:00');
      if (dueAt.getTime() > now.getTime()) reminderDates.add(task.plannedDate);
    }
  }

  const orderedDates = Array.from(reminderDates).sort();
  // iOS limits pending local notifications; Android AlarmManager has no matching
  // 55-request limit, so keep every distinct follow-up date scheduled there.
  const selectedDates = Platform.OS === 'ios'
    ? orderedDates.slice(0, MAX_SCHEDULED_REMINDERS)
    : orderedDates;
  const permission = await Notifications.getPermissionsAsync();
  const desiredDates = new Set(selectedDates);
  const scheduled = await Notifications.getAllScheduledNotificationsAsync();
  const keptDates = new Set<string>();

  for (const request of scheduled) {
    if (request.content.data?.kind !== 'followup-reminder') continue;
    const scheduledDate = request.content.data?.date;
    const date = typeof scheduledDate === 'string' ? scheduledDate : '';
    if (forceReschedule || !desiredDates.has(date) || keptDates.has(date)) {
      await Notifications.cancelScheduledNotificationAsync(request.identifier);
      continue;
    }
    keptDates.add(date);
  }

  if (!permission.granted) return;

  for (const key of selectedDates) {
    if (!forceReschedule && keptDates.has(key)) continue;
    const date = new Date(key + 'T09:00:00');
    if (date.getTime() <= Date.now()) continue;
    try {
      await Notifications.scheduleNotificationAsync({
        content: {
          title: '患者随访提醒',
          body: '您有尚未完成的电话随访任务，请及时处理。',
          sound: 'default',
          vibrate: VIBRATION_PATTERN,
          data: { kind: 'followup-reminder', date: key, route: 'followups' },
        },
        trigger: {
          type: Notifications.SchedulableTriggerInputTypes.DATE,
          date,
          channelId: CHANNEL_ID,
          ...(Platform.OS === 'android' ? { delivery: 'alarmClock' as const } : {}),
        },
      });
    } catch {
      // Keep syncing later dates; the next app refresh retries any missing date.
    }
  }
}

