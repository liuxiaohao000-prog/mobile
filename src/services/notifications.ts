import { NativeModules, Platform } from 'react-native';
import { getTasks } from '../storage/repository';
import { syncCalendarFollowups } from './calendarReminders';

// Keep all calendar writes serialized: user-initiated updates and nonblocking
// foreground repairs must not create duplicate dates.
let calendarQueue: Promise<void> = Promise.resolve();
const nativeCleanup = NativeModules.FollowupReminder as
  | { cleanupLegacyAlarms?: () => Promise<boolean> }
  | undefined;

export async function configureNotifications(): Promise<void> {
  // Compatibility entrypoint, invoked after the encrypted database opens.
  // Remove legacy alarm PendingIntents when upgrading. It does not request
  // notification/exact-alarm permissions or create any local reminder.
  if (Platform.OS === 'android') {
    try {
      await nativeCleanup?.cleanupLegacyAlarms?.();
    } catch (error) {
      // Never prevent access to encrypted clinical data just because a
      // deprecated PendingIntent or notification channel cannot be cancelled.
      console.warn('Legacy alarm cleanup was incomplete:', error);
    }
  }
}

export function refreshLocalReminders(_forceReschedule = false): Promise<void> {
  const run = calendarQueue.then(async () => {
    const tasks = await getTasks();
    await syncCalendarFollowups(tasks);
  });
  calendarQueue = run.catch(error => {
    console.warn('System calendar sync failed:', error);
  });
  return run;
}
