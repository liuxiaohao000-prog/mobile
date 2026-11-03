import type { FollowupStatus } from '../types';

export function dateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return year + '-' + month + '-' + day;
}

export function parseLocalDate(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const [, year, month, day] = match;
  const date = new Date(Number(year), Number(month) - 1, Number(day));
  if (
    date.getFullYear() !== Number(year) ||
    date.getMonth() !== Number(month) - 1 ||
    date.getDate() !== Number(day)
  ) return null;
  return date;
}

export function parseLocalDateTime(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const [, year, month, day, hour, minute] = match;
  const date = new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    0,
    0,
  );
  if (
    date.getFullYear() !== Number(year) ||
    date.getMonth() !== Number(month) - 1 ||
    date.getDate() !== Number(day)
  ) {
    return null;
  }
  return date;
}

export function formatLocalDateTime(date: Date): string {
  return dateKey(date) + ' ' +
    String(date.getHours()).padStart(2, '0') + ':' +
    String(date.getMinutes()).padStart(2, '0');
}

export function addCalendarMonthsClamped(enrollmentAt: string, months: number): string {
  const enrolled = parseLocalDate(enrollmentAt) ?? new Date(enrollmentAt);
  const originalDay = enrolled.getDate();
  const targetFirst = new Date(
    enrolled.getFullYear(),
    enrolled.getMonth() + months,
    1,
    enrolled.getHours(),
    enrolled.getMinutes(),
  );
  const lastDay = new Date(
    targetFirst.getFullYear(),
    targetFirst.getMonth() + 1,
    0,
  ).getDate();
  targetFirst.setDate(Math.min(originalDay, lastDay));
  return dateKey(targetFirst);
}

export function getFollowupStatus(
  plannedDate: string,
  storedStatus: string,
  patientStatus = 'ACTIVE',
  now = new Date(),
): FollowupStatus {
  if (storedStatus === 'COMPLETED') return 'COMPLETED';
  if (storedStatus === 'CANCELLED' || patientStatus === 'EXITED') return 'CANCELLED';
  const today = dateKey(now);
  if (today < plannedDate) return 'PENDING';
  if (today === plannedDate) return 'DUE';
  return 'OVERDUE';
}

