import * as Crypto from 'expo-crypto';
import { AESEncryptionKey, AESSealedData, aesDecryptAsync, aesEncryptAsync } from 'expo-crypto';
import { Directory, File, Paths } from 'expo-file-system';
import { pbkdf2Async } from '@noble/hashes/pbkdf2.js';
import { sha256 } from '@noble/hashes/sha2.js';
import {
  closeCachedDatabaseForRestore,
  getDatabase,
  getDatabaseSnapshot,
  resetDatabaseConnection,
  setDatabaseKeyFromBackup,
} from '../storage/database';
import {
  SECURE_FILES_DIRECTORY,
  getFileEncryptionKeyForBackup,
  setFileEncryptionKeyFromBackup,
} from '../storage/secureFiles';
import { getAiSettings, saveAiSettings, type AiSettings } from './settings';

const BACKUP_MAGIC = 'YANBAN-PATIENT-FOLLOWUP-BACKUP';
const BACKUP_VERSION = 1;
const KDF_ITERATIONS = 250_000;
// Android's Storage Access Framework may append the extension implied by the
// MIME type. Include .json here so the persisted filename is stable there too.
const MANIFEST_NAME = 'manifest.yfb.json';
const DATABASE_FILE_NAME = 'database.yfbe';
const DATABASE_AAD = `${BACKUP_MAGIC}:database`;
const METADATA_AAD = `${BACKUP_MAGIC}:metadata`;
const BACKUP_MIME = 'application/octet-stream';

type BackupAttachment = {
  sourceUri: string;
  sourceName: string;
  backupName: string;
};

type BackupMetadata = {
  applicationId: string;
  createdAt: string;
  databaseKey: string;
  fileEncryptionKey: string;
  aiSettings: AiSettings;
  attachments: BackupAttachment[];
};

type BackupManifest = {
  magic: string;
  version: number;
  iterations: number;
  salt: string;
  databaseFile: string;
  attachments: string[];
  encryptedMetadata: string;
};

type StagedAttachment = {
  sourceUri: string;
  destination: File;
};

function utf8ToBytes(value: string): Uint8Array {
  const escaped = encodeURIComponent(value);
  const bytes: number[] = [];
  for (let index = 0; index < escaped.length; index += 1) {
    if (escaped[index] === '%') {
      bytes.push(Number.parseInt(escaped.slice(index + 1, index + 3), 16));
      index += 2;
    } else {
      bytes.push(escaped.charCodeAt(index));
    }
  }
  return Uint8Array.from(bytes);
}

function bytesToUtf8(bytes: Uint8Array): string {
  let escaped = '';
  for (const byte of bytes) escaped += `%${byte.toString(16).padStart(2, '0')}`;
  return decodeURIComponent(escaped);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function validatePassphrase(passphrase: string): void {
  if (passphrase.length < 12) throw new Error('备份口令至少需要 12 位。');
}

async function deriveBackupKey(passphrase: string, salt: Uint8Array): Promise<AESEncryptionKey> {
  const derived = await pbkdf2Async(sha256, passphrase, salt, {
    c: KDF_ITERATIONS,
    dkLen: 32,
    asyncTick: 8,
  });
  return AESEncryptionKey.import(derived);
}

async function encryptBytes(
  bytes: Uint8Array,
  key: AESEncryptionKey,
  additionalData: string,
): Promise<Uint8Array> {
  const sealed = await aesEncryptAsync(bytes, key, { additionalData: utf8ToBytes(additionalData) });
  return sealed.combined();
}

async function decryptBytes(
  bytes: Uint8Array,
  key: AESEncryptionKey,
  additionalData: string,
): Promise<Uint8Array> {
  return aesDecryptAsync(AESSealedData.fromCombined(bytes), key, {
    output: 'bytes',
    additionalData: utf8ToBytes(additionalData),
  });
}

function fileEntries(directory: Directory): File[] {
  return directory.list().filter((entry): entry is File => entry instanceof File);
}

function attachmentSuffix(name: string): string {
  if (name.endsWith('.png.enc')) return '.png.enc';
  if (name.endsWith('.jpg.enc')) return '.jpg.enc';
  throw new Error('备份中包含无法识别的附件类型。');
}

function isValidMetadata(value: unknown): value is BackupMetadata {
  if (!value || typeof value !== 'object') return false;
  const metadata = value as Partial<BackupMetadata>;
  return (
    metadata.applicationId === 'com.local.patientfollowup' &&
    typeof metadata.createdAt === 'string' &&
    typeof metadata.databaseKey === 'string' &&
    /^[0-9a-f]{64}$/i.test(metadata.databaseKey) &&
    typeof metadata.fileEncryptionKey === 'string' &&
    /^[0-9a-f]{64}$/i.test(metadata.fileEncryptionKey) &&
    !!metadata.aiSettings &&
    typeof metadata.aiSettings.apiKey === 'string' &&
    typeof metadata.aiSettings.baseUrl === 'string' &&
    typeof metadata.aiSettings.model === 'string' &&
    Array.isArray(metadata.attachments) &&
    metadata.attachments.every(
      (attachment) =>
        !!attachment &&
        typeof attachment.sourceUri === 'string' &&
        typeof attachment.sourceName === 'string' &&
        /^[a-zA-Z0-9-]+\.(?:png|jpg)\.enc$/.test(attachment.sourceName) &&
        typeof attachment.backupName === 'string' &&
        /^attachment-\d{4}\.yfbe$/.test(attachment.backupName),
    )
  );
}

export async function createEncryptedBackup(passphrase: string): Promise<string> {
  validatePassphrase(passphrase);
  const selectedDirectory = await Directory.pickDirectoryAsync();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupFolderName = `PatientFollowup-${timestamp}`;
  const backupDirectory = selectedDirectory.createDirectory(backupFolderName);
  const salt = Crypto.getRandomBytes(16);
  const encryptionKey = await deriveBackupKey(passphrase, salt);

  try {
    const database = await getDatabaseSnapshot();
    const secureDirectory = new Directory(Paths.document, SECURE_FILES_DIRECTORY);
    const localAttachments = secureDirectory.exists ? fileEntries(secureDirectory) : [];
    const attachmentEntries: BackupAttachment[] = [];
    const attachmentFiles: File[] = [];

    for (const attachment of localAttachments) {
      if (!attachment.name.endsWith('.png.enc') && !attachment.name.endsWith('.jpg.enc')) continue;
      const index = attachmentEntries.length;
      const backupName = `attachment-${String(index).padStart(4, '0')}.yfbe`;
      attachmentEntries.push({
        sourceUri: attachment.uri,
        sourceName: attachment.name,
        backupName,
      });
      attachmentFiles.push(attachment);
    }

    const aiSettings = await getAiSettings();
    const metadata: BackupMetadata = {
      applicationId: 'com.local.patientfollowup',
      createdAt: new Date().toISOString(),
      databaseKey: database.key,
      fileEncryptionKey: await getFileEncryptionKeyForBackup(),
      aiSettings,
      attachments: attachmentEntries,
    };
    const encryptedMetadata = await encryptBytes(
      utf8ToBytes(JSON.stringify(metadata)),
      encryptionKey,
      METADATA_AAD,
    );
    const encryptedDatabase = await encryptBytes(database.bytes, encryptionKey, DATABASE_AAD);
    const databaseFile = backupDirectory.createFile(DATABASE_FILE_NAME, BACKUP_MIME);
    await databaseFile.write(encryptedDatabase);

    for (let index = 0; index < attachmentFiles.length; index += 1) {
      const source = attachmentFiles[index];
      const entry = attachmentEntries[index];
      const encryptedAttachment = await encryptBytes(
        await source.bytes(),
        encryptionKey,
        `${BACKUP_MAGIC}:attachment:${index}`,
      );
      const destination = backupDirectory.createFile(entry.backupName, BACKUP_MIME);
      await destination.write(encryptedAttachment);
    }

    const manifest: BackupManifest = {
      magic: BACKUP_MAGIC,
      version: BACKUP_VERSION,
      iterations: KDF_ITERATIONS,
      salt: bytesToBase64(salt),
      databaseFile: DATABASE_FILE_NAME,
      attachments: attachmentEntries.map((attachment) => attachment.backupName),
      encryptedMetadata: bytesToBase64(encryptedMetadata),
    };
    const manifestFile = backupDirectory.createFile(MANIFEST_NAME, 'application/json');
    await manifestFile.write(utf8ToBytes(JSON.stringify(manifest)));
    return backupFolderName;
  } catch (error) {
    try {
      if (backupDirectory.exists) backupDirectory.delete();
    } catch {
      // A partial backup is never reported as successful.
    }
    throw error;
  }
}

export async function restoreEncryptedBackup(
  passphrase: string,
): Promise<{ folderName: string; attachmentCount: number }> {
  validatePassphrase(passphrase);
  const backupDirectory = await Directory.pickDirectoryAsync();
  const entries = fileEntries(backupDirectory);
  const manifestFile = entries.find((entry) => entry.name === MANIFEST_NAME);
  if (!manifestFile) throw new Error('所选文件夹中找不到研伴加密备份清单。');

  let manifest: BackupManifest;
  try {
    manifest = JSON.parse(await manifestFile.text()) as BackupManifest;
  } catch {
    throw new Error('备份清单损坏或格式无法识别。');
  }
  if (
    manifest.magic !== BACKUP_MAGIC ||
    manifest.version !== BACKUP_VERSION ||
    manifest.iterations !== KDF_ITERATIONS ||
    manifest.databaseFile !== DATABASE_FILE_NAME ||
    !Array.isArray(manifest.attachments) ||
    typeof manifest.salt !== 'string' ||
    typeof manifest.encryptedMetadata !== 'string'
  ) {
    throw new Error('所选文件夹不是受支持的研伴备份。');
  }

  let encryptionKey: AESEncryptionKey;
  let metadata: BackupMetadata;
  try {
    encryptionKey = await deriveBackupKey(passphrase, base64ToBytes(manifest.salt));
    const metadataBytes = await decryptBytes(
      base64ToBytes(manifest.encryptedMetadata),
      encryptionKey,
      METADATA_AAD,
    );
    const parsed = JSON.parse(bytesToUtf8(metadataBytes)) as unknown;
    if (!isValidMetadata(parsed)) throw new Error('备份信息无效。');
    metadata = parsed;
  } catch {
    throw new Error('备份口令不正确，或备份文件已损坏。');
  }
  if (manifest.attachments.length !== metadata.attachments.length) {
    throw new Error('备份附件清单不完整。');
  }
  if (
    manifest.attachments.some(
      (name, index) =>
        name !== metadata.attachments[index]?.backupName || !/^attachment-\d{4}\.yfbe$/.test(name),
    )
  ) {
    throw new Error('备份附件清单与加密内容不匹配。');
  }

  const databaseCipher = entries.find((entry) => entry.name === DATABASE_FILE_NAME);
  if (!databaseCipher) throw new Error('备份数据库文件缺失。');
  const databaseBytes = await decryptBytes(await databaseCipher.bytes(), encryptionKey, DATABASE_AAD);
  if (databaseBytes.length < 100) throw new Error('备份数据库文件无效。');

  const secureDirectory = new Directory(Paths.document, SECURE_FILES_DIRECTORY);
  secureDirectory.create({ idempotent: true, intermediates: true });
  const oldAttachmentFiles = fileEntries(secureDirectory);
  const stagedAttachments: StagedAttachment[] = [];
  const mapping = new Map<string, string>();

  try {
    for (let index = 0; index < metadata.attachments.length; index += 1) {
      const attachment = metadata.attachments[index];
      const source = entries.find((entry) => entry.name === attachment.backupName);
      if (!source) throw new Error(`备份附件缺失：${attachment.backupName}`);
      const innerEncryptedBytes = await decryptBytes(
        await source.bytes(),
        encryptionKey,
        `${BACKUP_MAGIC}:attachment:${index}`,
      );
      const destination = new File(
        secureDirectory,
        Crypto.randomUUID() + attachmentSuffix(attachment.sourceName),
      );
      destination.create({ intermediates: true, overwrite: false });
      await destination.write(innerEncryptedBytes);
      stagedAttachments.push({ sourceUri: attachment.sourceUri, destination });
      mapping.set(attachment.sourceUri, destination.uri);
    }
  } catch (error) {
    for (const staged of stagedAttachments) {
      try {
        if (staged.destination.exists) staged.destination.delete();
      } catch {
        // Best effort cleanup of files that were not linked to a database.
      }
    }
    throw error;
  }

  const oldDatabase = await getDatabaseSnapshot();
  const oldFileKey = await getFileEncryptionKeyForBackup();
  const oldAiSettings = await getAiSettings();
  const databasePath = await closeCachedDatabaseForRestore();
  const databaseFile = new File(databasePath);
  const walFile = new File(`${databasePath}-wal`);
  const shmFile = new File(`${databasePath}-shm`);

  try {
    if (walFile.exists) walFile.delete();
    if (shmFile.exists) shmFile.delete();
    await databaseFile.write(databaseBytes);
    await setDatabaseKeyFromBackup(metadata.databaseKey);
    await setFileEncryptionKeyFromBackup(metadata.fileEncryptionKey);

    const restoredDatabase = await getDatabase();
    const integrity = await restoredDatabase.getFirstAsync<{ integrity_check: string }>(
      'PRAGMA integrity_check',
    );
    if (integrity?.integrity_check !== 'ok') throw new Error('备份数据库校验失败。');

    const pathColumns = [
      ['screening_case', 'ecg_path'],
      ['screening_revision', 'ecg_path'],
      ['consent_record', 'evidence_path'],
    ] as const;
    await restoredDatabase.withExclusiveTransactionAsync(async (transaction) => {
      for (const [oldUri, newUri] of mapping) {
        for (const [table, column] of pathColumns) {
          await transaction.runAsync(
            `UPDATE ${table} SET ${column} = ? WHERE ${column} = ?`,
            newUri,
            oldUri,
          );
        }
      }
    });
    await saveAiSettings(metadata.aiSettings);

    const restoredUris = new Set(stagedAttachments.map((attachment) => attachment.destination.uri));
    for (const oldFile of oldAttachmentFiles) {
      if (restoredUris.has(oldFile.uri)) continue;
      try {
        if (oldFile.exists) oldFile.delete();
      } catch {
        // A leftover unreferenced encrypted image does not affect restored records.
      }
    }
    return { folderName: backupDirectory.name, attachmentCount: stagedAttachments.length };
  } catch (error) {
    try {
      await closeCachedDatabaseForRestore();
    } catch {
      // The attempted database open may already have failed and reset its cached connection.
    }
    try {
      if (walFile.exists) walFile.delete();
      if (shmFile.exists) shmFile.delete();
      await databaseFile.write(oldDatabase.bytes);
      await setDatabaseKeyFromBackup(oldDatabase.key);
      await setFileEncryptionKeyFromBackup(oldFileKey);
      resetDatabaseConnection();
      const rollbackDatabase = await getDatabase();
      await rollbackDatabase.getFirstAsync<{ integrity_check: string }>('PRAGMA integrity_check');
      await saveAiSettings(oldAiSettings);
    } catch {
      resetDatabaseConnection();
    }
    for (const staged of stagedAttachments) {
      try {
        if (staged.destination.exists) staged.destination.delete();
      } catch {
        // Best effort cleanup after rolling back the database.
      }
    }
    throw error;
  }
}
