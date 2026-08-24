import dayjs, { type Dayjs } from 'dayjs';

export const DEFAULT_DATE_PATTERN = 'YYYY-MM-DD';
export const DEFAULT_DATETIME_PATTERN = 'YYYY-MM-DD HH:mm:ss';

export function today(): Dayjs {
  return dayjs().startOf('day');
}

export function now(): Dayjs {
  return dayjs();
}

export function formatDate(date: Dayjs, pattern: string = DEFAULT_DATE_PATTERN): string {
  return date.format(pattern);
}

export function formatDateTime(dateTime: Dayjs, pattern: string = DEFAULT_DATETIME_PATTERN): string {
  return dateTime.format(pattern);
}

export function parseDate(text: string, pattern: string = DEFAULT_DATE_PATTERN): Dayjs {
  return dayjs(text, pattern);
}

export function parseDateTime(text: string, pattern: string = DEFAULT_DATETIME_PATTERN): Dayjs {
  return dayjs(text, pattern);
}

export function addDays(date: Dayjs, days: number): Dayjs {
  return date.add(days, 'day');
}

export function addMonths(date: Dayjs, months: number): Dayjs {
  return date.add(months, 'month');
}

export function addHours(dateTime: Dayjs, hours: number): Dayjs {
  return dateTime.add(hours, 'hour');
}

export function addMinutes(dateTime: Dayjs, minutes: number): Dayjs {
  return dateTime.add(minutes, 'minute');
}

export function daysBetween(start: Dayjs, end: Dayjs): number {
  return end.diff(start, 'day');
}

export function isBefore(date: Dayjs, other: Dayjs): boolean {
  return date.isBefore(other);
}

export function isAfter(date: Dayjs, other: Dayjs): boolean {
  return date.isAfter(other);
}

export function toEpochMillis(dateTime: Dayjs): number {
  return dateTime.valueOf();
}

export function fromEpochMillis(epochMillis: number): Dayjs {
  return dayjs(epochMillis);
}

/** e.g. "20260825-143005-123" - safe to use in a screenshot/report file name. */
export function timestampForFileName(): string {
  return dayjs().format('YYYYMMDD-HHmmss-SSS');
}
