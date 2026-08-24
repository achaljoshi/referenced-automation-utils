import { test, expect } from '@playwright/test';
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
});
