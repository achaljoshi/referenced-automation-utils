import { test, expect } from '@playwright/test';
import * as os from 'node:os';
import * as path from 'node:path';
import * as excelUtils from '../src/data/excelUtils';

test.describe('excelUtils', () => {
  test('writeSheet/readSheet round-trip', async () => {
    const filePath = path.join(os.tmpdir(), `utils-test-${Date.now()}.xlsx`);
    const rows = [
      { id: 1, name: 'Ada' },
      { id: 2, name: 'Grace' },
    ];
    await excelUtils.writeSheet(filePath, rows);
    const readBack = await excelUtils.readSheet(filePath);
    expect(readBack).toEqual(rows);
  });
});
