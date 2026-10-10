import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
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

  test('parseDate honours a non-default pattern: 25/12/2026 is valid and 03/04/2026 is 3 April', () => {
    const christmas = dateUtils.parseDate('25/12/2026', 'DD/MM/YYYY');
    expect(christmas.isValid()).toBe(true);
    expect(dateUtils.formatDate(christmas)).toBe('2026-12-25');
    expect(dateUtils.formatDate(dateUtils.parseDate('03/04/2026', 'DD/MM/YYYY'))).toBe('2026-04-03');
    expect(dateUtils.formatDateTime(dateUtils.parseDateTime('03/04/2026 07:08', 'DD/MM/YYYY HH:mm'))).toBe('2026-04-03 07:08:00');
  });

  test('...in a fresh process that loads only the date module (no other module has registered the dayjs plugin)', () => {
    const dateModule = path.resolve(__dirname, '../dist/date/dateUtils.js');
    const script = `const d = require(${JSON.stringify(dateModule)}); process.stdout.write(JSON.stringify([d.parseDate('25/12/2026','DD/MM/YYYY').isValid(), d.formatDate(d.parseDate('03/04/2026','DD/MM/YYYY'))]))`;
    const run = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
    expect(run.stderr).toBe('');
    expect(JSON.parse(run.stdout)).toEqual([true, '2026-04-03']);
  });
});
