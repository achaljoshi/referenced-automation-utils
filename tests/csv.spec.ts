import { test, expect } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as csvUtils from '../src/data/csvUtils';

test.describe('csvUtils', () => {
  test('toCsv/parseCsv round-trip', () => {
    const rows = [
      { id: '1', name: 'Ada' },
      { id: '2', name: 'Grace' },
    ];
    const csv = csvUtils.toCsv(rows);
    expect(csv).toContain('id,name');
    expect(csvUtils.parseCsv(csv)).toEqual(rows);
  });

  test('values with commas, quotes and line breaks are quoted on write and read back unchanged', () => {
    const rows = [{ id: '1', note: 'a, b', quote: 'say "hi"', multi: 'line1\nline2' }];
    const csv = csvUtils.toCsv(rows);
    expect(csv).toBe('id,note,quote,multi\n1,"a, b","say ""hi""","line1\nline2"\n');
    expect(csvUtils.parseCsv(csv)).toEqual(rows);
  });

  test('empty cells stay empty strings (not dropped, not undefined) and keep their column', () => {
    expect(csvUtils.toCsv([{ a: 'x', b: '', c: 'z' }])).toBe('a,b,c\nx,,z\n');
    expect(csvUtils.parseCsv('a,b,c\nx,,z\n,,\n')).toEqual([
      { a: 'x', b: '', c: 'z' },
      { a: '', b: '', c: '' },
    ]);
  });

  test('blank lines are skipped, unquoted padding is trimmed, quoted padding is kept', () => {
    expect(csvUtils.parseCsv('a,b\n\n  1 ,"  2  "\n\n')).toEqual([{ a: '1', b: '  2  ' }]);
  });

  test('a Windows (CRLF) file with a UTF-8 byte-order mark does not corrupt the first header', () => {
    expect(csvUtils.parseCsv('﻿id,name\r\n1,Ada\r\n')).toEqual([{ id: '1', name: 'Ada' }]);
  });

  test('a row with too few or too many cells is an error, not a silently shifted record', () => {
    expect(() => csvUtils.parseCsv('a,b\n1\n')).toThrow(/columns/i);
    expect(() => csvUtils.parseCsv('a,b\n1,2,3\n')).toThrow(/columns/i);
  });

  test('a header-only file has no rows, and writeCsvFile/parseCsvFile round-trip through disk', () => {
    expect(csvUtils.parseCsv('a,b\n')).toEqual([]);
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'csv-')), 'rows.csv');
    const rows = [{ a: 'café, "au lait"', b: '' }];
    csvUtils.writeCsvFile(file, rows);
    expect(csvUtils.parseCsvFile(file)).toEqual(rows);
  });
});
