import { test, expect } from '@playwright/test';
import * as dateUtils from '../src/date/dateUtils';

test.describe('dateUtils', () => {
  test('format/parse round-trip', () => {
    const date = dateUtils.parseDate('2026-01-15');
    expect(dateUtils.formatDate(date)).toBe('2026-01-15');
  });

  test('addDays/addMonths/addHours/addMinutes', () => {
    const date = dateUtils.parseDate('2026-01-15');
    expect(dateUtils.formatDate(dateUtils.addDays(date, 10))).toBe('2026-01-25');
    expect(dateUtils.formatDate(dateUtils.addMonths(date, 1))).toBe('2026-02-15');

    const dateTime = dateUtils.parseDateTime('2026-01-15 10:00:00');
    expect(dateUtils.formatDateTime(dateUtils.addHours(dateTime, 5))).toBe('2026-01-15 15:00:00');
    expect(dateUtils.formatDateTime(dateUtils.addMinutes(dateTime, 90))).toBe(
      '2026-01-15 11:30:00',
    );
  });

  test('daysBetween/isBefore/isAfter', () => {
    const start = dateUtils.parseDate('2026-01-01');
    const end = dateUtils.parseDate('2026-01-11');
    expect(dateUtils.daysBetween(start, end)).toBe(10);
    expect(dateUtils.isBefore(start, end)).toBe(true);
    expect(dateUtils.isAfter(end, start)).toBe(true);
  });

  test('epoch millis round-trip', () => {
    const dateTime = dateUtils.parseDateTime('2026-01-15 10:00:00');
    const millis = dateUtils.toEpochMillis(dateTime);
    expect(dateUtils.formatDateTime(dateUtils.fromEpochMillis(millis))).toBe(
      dateUtils.formatDateTime(dateTime),
    );
  });

  test('timestampForFileName produces a sortable, filesystem-safe string', () => {
    const stamp = dateUtils.timestampForFileName();
    expect(stamp).toMatch(/^\d{8}-\d{6}-\d{3}$/);
  });
});
