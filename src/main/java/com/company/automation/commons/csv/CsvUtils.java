package com.company.automation.commons.csv;

import com.company.automation.commons.exceptions.CommonsException;
import com.opencsv.CSVReader;
import com.opencsv.CSVWriter;
import com.opencsv.exceptions.CsvException;

import java.io.FileReader;
import java.io.FileWriter;
import java.io.IOException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * CSV read/write helpers built on opencsv, mirroring {@link com.company.automation.commons.excel.ExcelUtils}
 * so data-driven tests can pick whichever tabular format their test data
 * happens to live in without learning a different API.
 */
public final class CsvUtils {

    private CsvUtils() {
    }

    /** Reads a CSV file into a list of rows keyed by the header row (row 0). */
    public static List<Map<String, String>> readAsMaps(String filePath) {
        List<List<String>> rows = readAsRows(filePath);
        if (rows.isEmpty()) {
            return new ArrayList<>();
        }
        List<String> headers = rows.get(0);
        List<Map<String, String>> records = new ArrayList<>();
        for (int i = 1; i < rows.size(); i++) {
            List<String> row = rows.get(i);
            Map<String, String> record = new LinkedHashMap<>();
            for (int col = 0; col < headers.size(); col++) {
                record.put(headers.get(col), col < row.size() ? row.get(col) : "");
            }
            records.add(record);
        }
        return records;
    }

    /** Reads a CSV file as raw rows, including the header row at index 0. */
    public static List<List<String>> readAsRows(String filePath) {
        try (CSVReader reader = new CSVReader(new FileReader(filePath))) {
            List<String[]> lines = reader.readAll();
            List<List<String>> rows = new ArrayList<>();
            for (String[] line : lines) {
                rows.add(List.of(line));
            }
            return rows;
        } catch (IOException | CsvException e) {
            throw new CommonsException("Failed to read CSV file: " + filePath, e);
        }
    }

    /** Writes a header row plus one row per record, in {@code columnOrder}. Overwrites the file if it exists. */
    public static void writeMaps(String filePath, List<String> columnOrder, List<Map<String, Object>> records) {
        try (CSVWriter writer = new CSVWriter(new FileWriter(filePath))) {
            writer.writeNext(columnOrder.toArray(new String[0]));
            for (Map<String, Object> record : records) {
                String[] line = new String[columnOrder.size()];
                for (int col = 0; col < columnOrder.size(); col++) {
                    Object value = record.get(columnOrder.get(col));
                    line[col] = value == null ? "" : String.valueOf(value);
                }
                writer.writeNext(line);
            }
        } catch (IOException e) {
            throw new CommonsException("Failed to write CSV file: " + filePath, e);
        }
    }

    /** Writes raw rows (no header assumption) to a CSV file. Overwrites the file if it exists. */
    public static void writeRows(String filePath, List<List<String>> rows) {
        try (CSVWriter writer = new CSVWriter(new FileWriter(filePath))) {
            for (List<String> row : rows) {
                writer.writeNext(row.toArray(new String[0]));
            }
        } catch (IOException e) {
            throw new CommonsException("Failed to write CSV file: " + filePath, e);
        }
    }
}
