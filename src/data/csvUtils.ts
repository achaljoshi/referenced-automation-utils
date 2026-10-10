import { parse } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';
import * as fs from 'node:fs';

/**
 * Parses CSV text into an array of row objects keyed by header column. A leading byte-order mark (Excel's "CSV UTF-8")
 * is dropped so the first header is not silently named "\ufeffid"; a row with the wrong number of cells throws.
 */
export function parseCsv(text: string): Record<string, string>[] {
  return parse(text, { columns: true, skip_empty_lines: true, trim: true, bom: true });
}

export function parseCsvFile(filePath: string): Record<string, string>[] {
  return parseCsv(fs.readFileSync(filePath, 'utf8'));
}

/** Serialises an array of row objects to CSV text, header row included. */
export function toCsv(rows: Record<string, unknown>[]): string {
  return stringify(rows, { header: true });
}

export function writeCsvFile(filePath: string, rows: Record<string, unknown>[]): void {
  fs.writeFileSync(filePath, toCsv(rows), 'utf8');
}
