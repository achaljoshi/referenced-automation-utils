import ExcelJS from 'exceljs';

/**
 * Reads a worksheet as an array of row objects keyed by its header row
 * (row 1) - the common shape needed for data-driven tests backed by an
 * Excel test-data file.
 */
export async function readSheet(
  filePath: string,
  sheetName?: string,
): Promise<Record<string, string | number | boolean | Date | null>[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const sheet = sheetName ? workbook.getWorksheet(sheetName) : workbook.worksheets[0];
  if (!sheet) {
    throw new Error(`Worksheet "${sheetName ?? '(first sheet)'}" not found in ${filePath}`);
  }

  const headerRow = sheet.getRow(1);
  const headers: string[] = [];
  headerRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {
    headers[colNumber] = String(cell.value ?? '');
  });

  const rows: Record<string, string | number | boolean | Date | null>[] = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const record: Record<string, string | number | boolean | Date | null> = {};
    row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      const header = headers[colNumber];
      if (!header) return;
      record[header] = normalizeCellValue(cell.value);
    });
    rows.push(record);
  });

  return rows;
}

/** Writes an array of row objects to a new .xlsx file, header row derived from object keys. */
export async function writeSheet(
  filePath: string,
  rows: Record<string, unknown>[],
  sheetName = 'Sheet1',
): Promise<void> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(sheetName);
  const headers = rows.length ? Object.keys(rows[0]!) : [];
  sheet.addRow(headers);
  for (const row of rows) {
    sheet.addRow(headers.map((header) => row[header] as ExcelJS.CellValue));
  }
  await workbook.xlsx.writeFile(filePath);
}

function normalizeCellValue(value: ExcelJS.CellValue): string | number | boolean | Date | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object' && 'text' in value) return String(value.text);
  if (typeof value === 'object' && 'result' in value) return value.result as string | number;
  if (value instanceof Date) return value;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  return String(value);
}
