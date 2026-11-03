import * as SecureStore from 'expo-secure-store';
import * as SQLite from 'expo-sqlite';
import { Directory, File, Paths } from 'expo-file-system';
import { NativeModules, Platform } from 'react-native';
import {
  AI_API_KEY_STORAGE,
  DATABASE_KEY_NAME,
  FILES_KEY_NAME,
} from '../storage/secureKeys';
import { getFileEncryptionKeyForBackup, SECURE_FILES_DIRECTORY } from '../storage/secureFiles';

const DATABASE_NAME = 'patient-followup.db';
const AUTO_BACKUP_FORMAT_VERSION = 1;

type AutoBackupMetadata = {
  applicationId: string;
  formatVersion: number;
  createdAt: string;
  databaseKey: string;
  fileEncryptionKey: string;
  aiApiKey: string;
  attachments: string[];
};

type NativeAutoBackupModule = {
  createAutomaticBackup(metadataJson: string, databaseUri: string, attachmentUris: string[]): Promise<string>;
  restoreAutomaticBackup(): Promise<string | null>;
  hasBackupAccess(): Promise<boolean>;
  getBackupDirectoryName(): Promise<string | null>;
  selectBackupDirectory(): Promise<boolean>;
};

const nativeBackup = NativeModules.PatientAutoBackup as NativeAutoBackupModule | undefined;
let changeSubscription: ReturnType<typeof SQLite.addDatabaseChangeListener> | undefined;
let pendingTimer: ReturnType<typeof setTimeout> | undefined;
let backupRunning = false;
let rerunAfterCurrentBackup = false;

function requireNativeBackup(): NativeAutoBackupModule {
  if (!nativeBackup) throw new Error('自动备份原生模块未安装，请重新安装完整 APK。');
  return nativeBackup;
}

export async function hasAutomaticBackupAccess(): Promise<boolean> {
  if (Platform.OS !== 'android') return true;
  return requireNativeBackup().hasBackupAccess();
}

export async function getAutomaticBackupDirectoryName(): Promise<string | null> {
  if (Platform.OS !== 'android') return null;
  return requireNativeBackup().getBackupDirectoryName();
}

export async function requestAutomaticBackupAccess(): Promise<boolean> {
  if (Platform.OS !== 'android') return true;
  return requireNativeBackup().selectBackupDirectory();
}

function listAttachmentFiles(directory: Directory): File[] {
  if (!directory.exists) return [];
  return directory.list().filter(
    (entry): entry is File =>
      entry instanceof File && (entry.name.endsWith('.png.enc') || entry.name.endsWith('.jpg.enc')),
  );
}

function parseMetadata(raw: string): AutoBackupMetadata {
  const value = JSON.parse(raw) as Partial<AutoBackupMetadata>;
  if (
    value.applicationId !== 'com.local.patientfollowup' ||
    value.formatVersion !== AUTO_BACKUP_FORMAT_VERSION ||
    typeof value.createdAt !== 'string' ||
    typeof value.databaseKey !== 'string' ||
    !/^[0-9a-f]{64}$/i.test(value.databaseKey) ||
    typeof value.fileEncryptionKey !== 'string' ||
    !/^[0-9a-f]{64}$/i.test(value.fileEncryptionKey) ||
    typeof value.aiApiKey !== 'string' ||
    !Array.isArray(value.attachments) ||
    !value.attachments.every((name) => /^[A-Za-z0-9-]+\.(png|jpg)\.enc$/.test(name))
  ) {
    throw new Error('本机自动备份清单无效或版本不受支持。');
  }
  return value as AutoBackupMetadata;
}

export async function restoreAutomaticBackupIfNeeded(): Promise<void> {
  const raw = await requireNativeBackup().restoreAutomaticBackup();
  if (!raw) return;

  const metadata = parseMetadata(raw);
  try {
    await SecureStore.setItemAsync(DATABASE_KEY_NAME, metadata.databaseKey.toLowerCase());
    await SecureStore.setItemAsync(FILES_KEY_NAME, metadata.fileEncryptionKey.toLowerCase());
    await SecureStore.setItemAsync(AI_API_KEY_STORAGE, metadata.aiApiKey);
  } catch (error) {
    const databaseFile = new File(Paths.document, 'SQLite', DATABASE_NAME);
    if (databaseFile.exists) databaseFile.delete();
    throw error;
  }
}

async function writeAutomaticBackup(database: SQLite.SQLiteDatabase): Promise<void> {
  await database.execAsync('PRAGMA wal_checkpoint(TRUNCATE);');
  const databaseFile = new File(Paths.document, 'SQLite', DATABASE_NAME);
  if (!databaseFile.exists) throw new Error('找不到本机数据库文件。');

  const secureDirectory = new Directory(Paths.document, SECURE_FILES_DIRECTORY);
  const attachments = listAttachmentFiles(secureDirectory);
  const [databaseKey, fileEncryptionKey, aiApiKey] = await Promise.all([
    SecureStore.getItemAsync(DATABASE_KEY_NAME),
    getFileEncryptionKeyForBackup(),
    SecureStore.getItemAsync(AI_API_KEY_STORAGE),
  ]);
  if (!databaseKey || !fileEncryptionKey) throw new Error('本机加密密钥尚未就绪。');

  const metadata: AutoBackupMetadata = {
    applicationId: 'com.local.patientfollowup',
    formatVersion: AUTO_BACKUP_FORMAT_VERSION,
    createdAt: new Date().toISOString(),
    databaseKey,
    fileEncryptionKey,
    aiApiKey: aiApiKey ?? '',
    attachments: attachments.map((file) => file.name),
  };

  await requireNativeBackup().createAutomaticBackup(
    JSON.stringify(metadata),
    databaseFile.uri,
    attachments.map((file) => file.uri),
  );
}

function scheduleAutomaticBackup(database: SQLite.SQLiteDatabase): void {
  if (backupRunning) {
    rerunAfterCurrentBackup = true;
    return;
  }
  if (pendingTimer) clearTimeout(pendingTimer);
  pendingTimer = setTimeout(() => {
    pendingTimer = undefined;
    void (async () => {
      if (backupRunning) {
        rerunAfterCurrentBackup = true;
        return;
      }
      backupRunning = true;
      try {
        do {
          rerunAfterCurrentBackup = false;
          await writeAutomaticBackup(database);
        } while (rerunAfterCurrentBackup);
      } catch (error) {
        console.warn('本机自动备份未完成。', error);
      } finally {
        backupRunning = false;
      }
    })();
  }, 900);
}

export function startAutomaticBackup(database: SQLite.SQLiteDatabase): void {
  requireNativeBackup();
  if (!changeSubscription) {
    changeSubscription = SQLite.addDatabaseChangeListener((event) => {
      if (event.databaseFilePath === database.databasePath) {
        scheduleAutomaticBackup(database);
      }
    });
  }
  // Refresh on startup as well, so schema migrations and an interrupted prior
  // write are reflected in the next restore point.
  scheduleAutomaticBackup(database);
}
