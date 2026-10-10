import { test, expect } from '@playwright/test';
import ExcelJS from 'exceljs';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as excelUtils from '../src/data/excelUtils';

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'xlsx-')), 'data.xlsx');

test.describe('excelUtils', () => {
  test('writeSheet/readSheet round-trip', async () => {
    const filePath = tmpFile();
    const rows = [
      { id: 1, name: 'Ada' },
      { id: 2, name: 'Grace' },
    ];
    await excelUtils.writeSheet(filePath, rows);
    const readBack = await excelUtils.readSheet(filePath);
    expect(readBack).toEqual(rows);
  });

  test('a rich-text cell reads as its plain text, not "[object Object]"', async () => {
    const filePath = tmpFile();
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Data');
    sheet.addRow(['title', 'plain']);
    sheet.addRow([
      { richText: [{ text: 'Hello ', font: { bold: true } }, { text: 'World', font: { color: { argb: 'FFFF0000' } } }] },
      'x',
    ]);
    await workbook.xlsx.writeFile(filePath);
    expect(await excelUtils.readSheet(filePath)).toEqual([{ title: 'Hello World', plain: 'x' }]);
  });

  test('hyperlink, formula, date, boolean and empty cells read as plain values; a never-calculated formula is null', async () => {
    const filePath = tmpFile();
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Data');
    sheet.addRow(['link', 'sum', 'when', 'flag', 'blank', 'pending']);
    const when = new Date('2026-03-04T05:06:07Z');
    const row = sheet.addRow([{ text: 'docs', hyperlink: 'https://example.test/' }, { formula: '1+2', result: 3 }, when, true, null, { formula: '4+5' }]);
    row.commit();
    await workbook.xlsx.writeFile(filePath);
    const [read] = await excelUtils.readSheet(filePath);
    expect(read).toEqual({ link: 'docs', sum: 3, when, flag: true, blank: null, pending: null });
  });

  test('a missing worksheet is reported by name; sheetName selects the sheet', async () => {
    const filePath = tmpFile();
    await excelUtils.writeSheet(filePath, [{ a: 1 }], 'First');
    await expect(excelUtils.readSheet(filePath, 'Nope')).rejects.toThrow(/Worksheet "Nope" not found/);
    expect(await excelUtils.readSheet(filePath, 'First')).toEqual([{ a: 1 }]);
  });
});
