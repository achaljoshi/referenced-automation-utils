package com.company.automation.commons.excel;

import com.company.automation.commons.exceptions.CommonsException;
import org.apache.poi.ss.usermodel.Cell;
import org.apache.poi.ss.usermodel.DataFormatter;
import org.apache.poi.ss.usermodel.Row;
import org.apache.poi.ss.usermodel.Sheet;
import org.apache.poi.ss.usermodel.Workbook;
import org.apache.poi.xssf.usermodel.XSSFWorkbook;

import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Excel (.xlsx) read/write helpers built on Apache POI, for data-driven
 * tests that keep their inputs/expected-results in spreadsheets rather than
 * feature-file examples tables.
 *
 * <p>Every value is read back as a {@link String} via POI's {@link DataFormatter}
 * so callers never have to branch on {@code CellType} (numeric vs. string vs.
 * formula vs. boolean) - the same way a human reads a spreadsheet.
 */
public final class ExcelUtils {

    private static final DataFormatter FORMATTER = new DataFormatter();

    private ExcelUtils() {
    }

    /**
     * Reads a sheet as a list of rows, each row a {@code Map<String, String>} keyed by
     * the header row (row 0). Trailing blank cells in a row are simply absent from the map.
     */
    public static List<Map<String, String>> readSheetAsMaps(String filePath, String sheetName) {
        try (FileInputStream fis = new FileInputStream(filePath); Workbook workbook = new XSSFWorkbook(fis)) {
            Sheet sheet = getSheet(workbook, sheetName);
            List<Map<String, String>> records = new ArrayList<>();

            Row headerRow = sheet.getRow(sheet.getFirstRowNum());
            if (headerRow == null) {
                return records;
            }
            List<String> headers = new ArrayList<>();
            for (Cell cell : headerRow) {
                headers.add(FORMATTER.formatCellValue(cell));
            }

            for (int rowIndex = sheet.getFirstRowNum() + 1; rowIndex <= sheet.getLastRowNum(); rowIndex++) {
                Row row = sheet.getRow(rowIndex);
                if (row == null) {
                    continue;
                }
                Map<String, String> record = new LinkedHashMap<>();
                for (int col = 0; col < headers.size(); col++) {
                    Cell cell = row.getCell(col);
                    record.put(headers.get(col), cell == null ? "" : FORMATTER.formatCellValue(cell));
                }
                records.add(record);
            }
            return records;
        } catch (IOException e) {
            throw new CommonsException("Failed to read Excel sheet '" + sheetName + "' from " + filePath, e);
        }
    }

    /** Reads a sheet as raw rows of strings, including the header row at index 0. No header assumption is made. */
    public static List<List<String>> readSheetAsRows(String filePath, String sheetName) {
        try (FileInputStream fis = new FileInputStream(filePath); Workbook workbook = new XSSFWorkbook(fis)) {
            Sheet sheet = getSheet(workbook, sheetName);
            List<List<String>> rows = new ArrayList<>();
            for (Row row : sheet) {
                List<String> values = new ArrayList<>();
                for (Cell cell : row) {
                    values.add(FORMATTER.formatCellValue(cell));
                }
                rows.add(values);
            }
            return rows;
        } catch (IOException e) {
            throw new CommonsException("Failed to read Excel sheet '" + sheetName + "' from " + filePath, e);
        }
    }

    /**
     * Writes a list of records to a new sheet, one column per key of {@code columnOrder}.
     * Creates the workbook file if it does not already exist; overwrites the sheet if it does.
     */
    public static void writeMapsToSheet(String filePath, String sheetName,
                                         List<String> columnOrder, List<Map<String, Object>> records) {
        try (Workbook workbook = new XSSFWorkbook()) {
            Sheet sheet = workbook.createSheet(sheetName);

            Row header = sheet.createRow(0);
            for (int col = 0; col < columnOrder.size(); col++) {
                header.createCell(col).setCellValue(columnOrder.get(col));
            }

            for (int rowIndex = 0; rowIndex < records.size(); rowIndex++) {
                Row row = sheet.createRow(rowIndex + 1);
                Map<String, Object> record = records.get(rowIndex);
                for (int col = 0; col < columnOrder.size(); col++) {
                    Object value = record.get(columnOrder.get(col));
                    row.createCell(col).setCellValue(value == null ? "" : String.valueOf(value));
                }
            }

            for (int col = 0; col < columnOrder.size(); col++) {
                sheet.autoSizeColumn(col);
            }

            try (FileOutputStream fos = new FileOutputStream(filePath)) {
                workbook.write(fos);
            }
        } catch (IOException e) {
            throw new CommonsException("Failed to write Excel sheet '" + sheetName + "' to " + filePath, e);
        }
    }

    private static Sheet getSheet(Workbook workbook, String sheetName) {
        Sheet sheet = workbook.getSheet(sheetName);
        if (sheet == null) {
            throw new CommonsException("Sheet not found: " + sheetName);
        }
        return sheet;
    }
}
