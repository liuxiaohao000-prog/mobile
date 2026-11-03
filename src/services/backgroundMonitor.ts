import { NativeModules, Platform } from 'react-native';
import { getTasks, getTotalEnrolledPatientCount } from '../storage/repository';
import type { FollowupTask } from '../types';
import { dateKey } from '../domain/dates';

// All data passed to the Android monitoring service is aggregate and anonymous.
// No patient names, IDs, phone numbers, medical records, or encrypted DB keys.
export type BackgroundMonitorState = {
  enabled: boolean;
  running: boolean;
  lastError: string;
  lastStartedAt: number;
  lastStoppedAt: number;
  lastStartReason: string;
  lastTaskRemovedAt: number;
  lastRestoreAttemptAt: number;
  startCount: number;
};

const monitor = NativeModules.FollowupMonitor as
  | {
      getMonitorStatus(): Promise<BackgroundMonitorState>;
      setMonitorEnabled(enabled: boolean): Promise<boolean>;
      updateMonitorSnapshot(pendingJson: string, completedJson: string, totalPatients: number): Promise<boolean>;
      restoreMonitorIfEnabled(): Promise<boolean>;
    }
  | undefined;

const available = Platform.OS === 'android' && Boolean(monitor);

export async function getBackgroundMonitorState(): Promise<BackgroundMonitorState> {
  if (!available || !monitor) return {
    enabled: false,
    running: false,
    lastError: '',
    lastStartedAt: 0,
    lastStoppedAt: 0,
    lastStartReason: '',
    lastTaskRemovedAt: 0,
    lastRestoreAttemptAt: 0,
    startCount: 0,
  };
  return monitor.getMonitorStatus();
}

function countByDate(dates: string[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const day of dates) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    result[day] = (result[day] ?? 0) + 1;
  }
  return result;
}

export async function syncBackgroundMonitorSnapshot(tasks?: FollowupTask[]): Promise<void> {
  if (!available || !monitor) return;
  const state = await monitor.getMonitorStatus();
  if (!state.enabled) return;

  const currentTasks = tasks ?? await getTasks();
  const pendingDates = currentTasks
    .filter((task) => task.status !== 'COMPLETED' && task.status !== 'CANCELLED')
    .map((task) => task.plannedDate);
  const completedDates = currentTasks
    .filter((task) => task.status === 'COMPLETED' && Boolean(task.completedAt))
    .map((task) => dateKey(new Date(task.completedAt!)));

  await monitor.updateMonitorSnapshot(
    JSON.stringify(countByDate(pendingDates)),
    JSON.stringify(countByDate(completedDates)),
    await getTotalEnrolledPatientCount(),
  );
}

export async function setBackgroundMonitorEnabled(enabled: boolean): Promise<void> {
  if (!available || !monitor) throw new Error('后台监测仅支持 Android 原生版。');
  if (enabled) {
    // Persist a correct summary before starting the foreground notification.
    // updateMonitorSnapshot skips disabled monitoring by default, so populate
    // the native cache via the enabled session's subsequent refresh as well.
    await monitor.setMonitorEnabled(true);
    try {
      await syncBackgroundMonitorSnapshot();
    } catch (error) {
      await monitor.setMonitorEnabled(false);
      throw error;
    }
  } else {
    await monitor.setMonitorEnabled(false);
  }
}

export async function restoreBackgroundMonitorIfEnabled(): Promise<void> {
  if (!available || !monitor) return;
  const state = await monitor.getMonitorStatus();
  if (state.enabled) {
    await syncBackgroundMonitorSnapshot();
    await monitor.restoreMonitorIfEnabled();
  }
}
