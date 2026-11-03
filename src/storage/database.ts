import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import * as SQLite from 'expo-sqlite';
import { File, Paths } from 'expo-file-system';
import { DATABASE_KEY_NAME } from './secureKeys';
import { restoreAutomaticBackupIfNeeded, startAutomaticBackup } from '../services/automaticBackup';

const DATABASE_NAME = 'patient-followup.db';
const DATABASE_DIRECTORY = 'SQLite';
export { DATABASE_KEY_NAME } from './secureKeys';

let databasePromise: Promise<SQLite.SQLiteDatabase> | undefined;

function getDatabaseFile(): File {
  // expo-sqlite stores its default Android database in files/SQLite. Its
  // databasePath is a native filesystem path, while expo-file-system expects
  // a file:// URI, so build the equivalent URI from the app document folder.
  return new File(Paths.document, DATABASE_DIRECTORY, DATABASE_NAME);
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function getOrCreateDatabaseKey(): Promise<string> {
  const stored = await SecureStore.getItemAsync(DATABASE_KEY_NAME);
  if (stored) return stored;

  const key = bytesToHex(await Crypto.getRandomBytesAsync(32));
  await SecureStore.setItemAsync(DATABASE_KEY_NAME, key);
  return key;
}

async function openDatabase(): Promise<SQLite.SQLiteDatabase> {
  if (!getDatabaseFile().exists) await restoreAutomaticBackupIfNeeded();
  const database = await SQLite.openDatabaseAsync(DATABASE_NAME, { enableChangeListener: true });
  const cipher = await database.getFirstAsync<{ cipher_version: string }>(
    'PRAGMA cipher_version',
  );
  if (!cipher?.cipher_version) {
    throw new Error(
      '当前安装包未启用 SQLCipher。请使用包含 expo-sqlite SQLCipher 原生配置的开发构建。',
    );
  }

  const key = await getOrCreateDatabaseKey();
  await database.execAsync('PRAGMA key = "x\'' + key + '\'";');
  await database.execAsync('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');

  const version = await database.getFirstAsync<{ user_version: number }>(
    'PRAGMA user_version',
  );
  if ((version?.user_version ?? 0) < 1) {
    await database.withTransactionAsync(async () => {
      await database.execAsync(
        [
          'CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)',
          'CREATE TABLE IF NOT EXISTS screening_case (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, age INTEGER NOT NULL, gender TEXT NOT NULL, clinical_json TEXT NOT NULL, ecg_path TEXT NOT NULL, status TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)',
          'CREATE TABLE IF NOT EXISTS screening_revision (id TEXT PRIMARY KEY NOT NULL, screening_id TEXT NOT NULL REFERENCES screening_case(id) ON DELETE CASCADE, version INTEGER NOT NULL, data_json TEXT NOT NULL, ecg_path TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(screening_id, version))',
          'CREATE TABLE IF NOT EXISTS ai_analysis_run (id TEXT PRIMARY KEY NOT NULL, screening_id TEXT NOT NULL REFERENCES screening_case(id) ON DELETE CASCADE, revision_id TEXT NOT NULL REFERENCES screening_revision(id), input_version INTEGER NOT NULL, model TEXT NOT NULL, protocol_version TEXT NOT NULL, verdict TEXT NOT NULL, result_json TEXT, error TEXT, created_at TEXT NOT NULL)',
          'CREATE TABLE IF NOT EXISTS missing_acknowledgement (id TEXT PRIMARY KEY NOT NULL, screening_id TEXT NOT NULL REFERENCES screening_case(id) ON DELETE CASCADE, analysis_id TEXT NOT NULL REFERENCES ai_analysis_run(id), missing_fields_json TEXT NOT NULL, actor TEXT NOT NULL, created_at TEXT NOT NULL)',
          'CREATE TABLE IF NOT EXISTS consent_record (id TEXT PRIMARY KEY NOT NULL, screening_id TEXT NOT NULL REFERENCES screening_case(id) ON DELETE CASCADE, decision TEXT NOT NULL, evidence_path TEXT, actor TEXT NOT NULL, created_at TEXT NOT NULL)',
          'CREATE TABLE IF NOT EXISTS qualification_verification (id TEXT PRIMARY KEY NOT NULL, screening_id TEXT NOT NULL REFERENCES screening_case(id) ON DELETE CASCADE, analysis_id TEXT NOT NULL REFERENCES ai_analysis_run(id), verifier TEXT NOT NULL, verified INTEGER NOT NULL, note TEXT NOT NULL, created_at TEXT NOT NULL)',
          'CREATE TABLE IF NOT EXISTS patient (id TEXT PRIMARY KEY NOT NULL, screening_id TEXT NOT NULL UNIQUE REFERENCES screening_case(id), patient_number TEXT NOT NULL UNIQUE, study_id TEXT NOT NULL, identity_fingerprint TEXT NOT NULL, name TEXT NOT NULL, age INTEGER NOT NULL, gender TEXT NOT NULL, phone TEXT NOT NULL, group_name TEXT NOT NULL, enrollment_at TEXT NOT NULL, enrolled_by TEXT NOT NULL, notes TEXT NOT NULL, status TEXT NOT NULL DEFAULT \'ACTIVE\', exited_at TEXT, exit_note TEXT, created_at TEXT NOT NULL, UNIQUE(study_id, identity_fingerprint))',
          'CREATE TABLE IF NOT EXISTS followup_task (id TEXT PRIMARY KEY NOT NULL, patient_id TEXT NOT NULL REFERENCES patient(id) ON DELETE CASCADE, node_month INTEGER NOT NULL, planned_date TEXT NOT NULL, status TEXT NOT NULL DEFAULT \'PENDING\', completed_at TEXT, cancelled_at TEXT, created_at TEXT NOT NULL, UNIQUE(patient_id, node_month))',
          'CREATE TABLE IF NOT EXISTS followup_record (id TEXT PRIMARY KEY NOT NULL, task_id TEXT NOT NULL REFERENCES followup_task(id) ON DELETE CASCADE, contacted_at TEXT NOT NULL, contact_result TEXT NOT NULL, completed INTEGER NOT NULL, patient_condition TEXT NOT NULL, notes TEXT NOT NULL, actor TEXT NOT NULL, created_at TEXT NOT NULL)',
          'CREATE TABLE IF NOT EXISTS audit_event (id TEXT PRIMARY KEY NOT NULL, action TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, actor TEXT NOT NULL, detail_json TEXT NOT NULL, created_at TEXT NOT NULL)',
          'CREATE INDEX IF NOT EXISTS idx_screening_updated ON screening_case(updated_at DESC)',
          'CREATE INDEX IF NOT EXISTS idx_patient_status ON patient(status)',
          'CREATE INDEX IF NOT EXISTS idx_followup_date_status ON followup_task(planned_date, status)',
          'CREATE INDEX IF NOT EXISTS idx_followup_patient ON followup_task(patient_id, node_month)',
        ].join(';'),
      );
      await database.execAsync('PRAGMA user_version = 1');
    });
  }
  if ((version?.user_version ?? 0) < 2) {
    await database.withTransactionAsync(async () => {
      await database.execAsync(
        [
          'CREATE TABLE qualification_verification_new (id TEXT PRIMARY KEY NOT NULL, screening_id TEXT NOT NULL REFERENCES screening_case(id) ON DELETE CASCADE, analysis_id TEXT REFERENCES ai_analysis_run(id), verifier TEXT NOT NULL, verified INTEGER NOT NULL, note TEXT NOT NULL, created_at TEXT NOT NULL)',
          'INSERT INTO qualification_verification_new(id, screening_id, analysis_id, verifier, verified, note, created_at) SELECT id, screening_id, analysis_id, verifier, verified, note, created_at FROM qualification_verification',
          'DROP TABLE qualification_verification',
          'ALTER TABLE qualification_verification_new RENAME TO qualification_verification',
        ].join(';'),
      );
      await database.execAsync('PRAGMA user_version = 2');
    });
  }
  startAutomaticBackup(database);
  return database;
}

export function getDatabase(): Promise<SQLite.SQLiteDatabase> {
  if (!databasePromise) {
    databasePromise = openDatabase().catch((error) => {
      databasePromise = undefined;
      throw error;
    });
  }
  return databasePromise;
}

export async function getDatabaseKeyForBackup(): Promise<string> {
  return getOrCreateDatabaseKey();
}

export async function setDatabaseKeyFromBackup(key: string): Promise<void> {
  if (!/^[0-9a-f]{64}$/i.test(key)) throw new Error('备份中的数据库密钥无效。');
  await SecureStore.setItemAsync(DATABASE_KEY_NAME, key.toLowerCase());
}

export async function getDatabaseSnapshot(): Promise<{ path: string; bytes: Uint8Array; key: string }> {
  const database = await getDatabase();
  await database.execAsync('PRAGMA wal_checkpoint(TRUNCATE);');
  const file = getDatabaseFile();
  if (!file.exists) throw new Error('找不到本机数据库文件，无法导出备份。');
  return {
    path: file.uri,
    bytes: await file.bytes(),
    key: await getOrCreateDatabaseKey(),
  };
}

export async function closeCachedDatabaseForRestore(): Promise<string> {
  if (!databasePromise) throw new Error('数据库尚未打开，无法恢复备份。');
  const database = await databasePromise;
  await database.execAsync('PRAGMA wal_checkpoint(TRUNCATE);');
  const databasePath = getDatabaseFile().uri;
  await database.closeAsync();
  databasePromise = undefined;
  return databasePath;
}

export function resetDatabaseConnection(): void {
  databasePromise = undefined;
}

export async function getMeta(key: string, fallback = ''): Promise<string> {
  const database = await getDatabase();
  const row = await database.getFirstAsync<{ value: string }>(
    'SELECT value FROM app_meta WHERE key = ?',
    key,
  );
  return row?.value ?? fallback;
}

export async function setMeta(key: string, value: string): Promise<void> {
  const database = await getDatabase();
  await database.runAsync(
    'INSERT INTO app_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    key,
    value,
  );
}

export async function addAuditEvent(
  action: string,
  entityType: string,
  entityId: string,
  actor: string,
  detail: Record<string, unknown> = {},
): Promise<void> {
  const database = await getDatabase();
  await database.runAsync(
    'INSERT INTO audit_event(id, action, entity_type, entity_id, actor, detail_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    Crypto.randomUUID(),
    action,
    entityType,
    entityId,
    actor,
    JSON.stringify(detail),
    new Date().toISOString(),
  );
}

