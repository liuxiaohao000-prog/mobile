import { md5 } from '@noble/hashes/legacy.js';

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function normalizePhone(phone: string): string {
  const trimmed = phone.trim();
  const hasPlus = trimmed.startsWith('+');
  const digits = trimmed.replace(/\D/g, '');
  return (hasPlus ? '+' : '') + digits;
}

export async function patientFingerprint(name: string, phone: string): Promise<string> {
  const canonicalName = name.normalize('NFKC').trim().replace(/\s+/g, '');
  const canonicalPhone = normalizePhone(phone);
  const message = new TextEncoder().encode(canonicalName + '\u0000' + canonicalPhone);
  return bytesToHex(md5(message));
}

