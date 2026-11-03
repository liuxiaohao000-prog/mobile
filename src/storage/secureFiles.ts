import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { Directory, File, Paths } from 'expo-file-system';
import * as ImageManipulator from 'expo-image-manipulator';
import { FILES_KEY_NAME } from './secureKeys';

export { FILES_KEY_NAME } from './secureKeys';
export const SECURE_FILES_DIRECTORY = 'patient-files';
let encryptionKeyPromise: Promise<Crypto.AESEncryptionKey> | undefined;

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function getFileEncryptionKey(): Promise<Crypto.AESEncryptionKey> {
  if (!encryptionKeyPromise) {
    encryptionKeyPromise = (async () => {
      let hex = await SecureStore.getItemAsync(FILES_KEY_NAME);
      if (!hex) {
        hex = bytesToHex(await Crypto.getRandomBytesAsync(32));
        await SecureStore.setItemAsync(FILES_KEY_NAME, hex);
      }
      return Crypto.AESEncryptionKey.import(hex, 'hex');
    })();
  }
  return encryptionKeyPromise;
}

function getSecureDirectory(): Directory {
  const directory = new Directory(Paths.document, SECURE_FILES_DIRECTORY);
  if (!directory.exists) directory.create({ idempotent: true, intermediates: true });
  return directory;
}

export async function getFileEncryptionKeyForBackup(): Promise<string> {
  await getFileEncryptionKey();
  const key = await SecureStore.getItemAsync(FILES_KEY_NAME);
  if (!key) throw new Error('找不到附件加密密钥，无法导出完整备份。');
  return key;
}

export async function setFileEncryptionKeyFromBackup(key: string): Promise<void> {
  if (!/^[0-9a-f]{64}$/i.test(key)) throw new Error('备份中的附件密钥无效。');
  await SecureStore.setItemAsync(FILES_KEY_NAME, key.toLowerCase());
  encryptionKeyPromise = undefined;
}

export async function storeEncryptedImage(sourceUri: string): Promise<string> {
  const original = new File(sourceUri);
  if (!original.exists) throw new Error('选择的图片文件已不可用，请重新选择。');

  let normalizedUri = sourceUri;
  let normalizedMime = original.type.toLowerCase();
  let temporaryUri = '';
  if (
    (!normalizedMime.includes('jpeg') && !normalizedMime.includes('jpg') && !normalizedMime.includes('png')) ||
    original.size > 20 * 1024 * 1024
  ) {
    const context = ImageManipulator.ImageManipulator.manipulate(sourceUri);
    context.resize({ width: 2560 });
    const rendered = await context.renderAsync();
    const normalized = await rendered.saveAsync({
      format: ImageManipulator.SaveFormat.JPEG,
      compress: 0.95,
    });
    normalizedUri = normalized.uri;
    normalizedMime = 'image/jpeg';
    temporaryUri = normalized.uri;
  }

  try {
    const plainBytes = await new File(normalizedUri).bytes();
    if (plainBytes.length > 20 * 1024 * 1024) {
      throw new Error('图片仍大于 20 MB，请选择更清晰且文件较小的心电图图片。');
    }
    const key = await getFileEncryptionKey();
    const sealed = await Crypto.aesEncryptAsync(plainBytes, key);
    const encryptedBytes = await sealed.combined();
    const extension = normalizedMime.includes('png') ? '.png.enc' : '.jpg.enc';
    const destination = new File(
      getSecureDirectory(),
      Crypto.randomUUID() + extension,
    );
    destination.create({ intermediates: true, overwrite: false });
    await destination.write(encryptedBytes);
    return destination.uri;
  } finally {
    if (temporaryUri) {
      const temporary = new File(temporaryUri);
      if (temporary.exists) temporary.delete();
    }
  }
}

export async function readEncryptedImage(uri: string): Promise<Uint8Array> {
  const file = new File(uri);
  if (!file.exists) throw new Error('心电图文件不存在，请重新上传。');
  const encryptedBytes = await file.bytes();
  const sealed = Crypto.AESSealedData.fromCombined(encryptedBytes);
  return Crypto.aesDecryptAsync(sealed, await getFileEncryptionKey(), {
    output: 'bytes',
  });
}

export function encryptedImageMimeType(uri: string): string {
  if (uri.endsWith('.png.enc')) return 'image/png';
  if (uri.endsWith('.webp.enc')) return 'image/webp';
  return 'image/jpeg';
}

export async function deleteEncryptedImage(uri?: string | null): Promise<void> {
  if (!uri) return;
  const file = new File(uri);
  if (file.exists) file.delete();
}

export async function bytesToBase64(bytes: Uint8Array): Promise<string> {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

