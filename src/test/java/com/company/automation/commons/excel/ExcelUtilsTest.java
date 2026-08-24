package com.company.automation.commons.excel;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;

class ExcelUtilsTest {

    @TempDir
    Path tempDir;

    @Test
    void writesAndReadsBackAsMaps() {
        String file = tempDir.resolve("data.xlsx").toString();
        List<String> columns = List.of("id", "name", "active");
        List<Map<String, Object>> records = List.of(
                Map.of("id", 1, "name", "Ada", "active", true),
                Map.of("id", 2, "name", "Grace", "active", false)
        );

        ExcelUtils.writeMapsToSheet(file, "Users", columns, records);
        List<Map<String, String>> readBack = ExcelUtils.readSheetAsMaps(file, "Users");

        assertEquals(2, readBack.size());
        assertEquals("Ada", readBack.get(0).get("name"));
        assertEquals("2", readBack.get(1).get("id"));
        assertEquals("false", readBack.get(1).get("active"));
    }

    @Test
    void readsSheetAsRawRowsIncludingHeader() {
        String file = tempDir.resolve("rows.xlsx").toString();
        ExcelUtils.writeMapsToSheet(file, "Sheet1", List.of("col1", "col2"),
                List.of(Map.of("col1", "x", "col2", "y")));

        List<List<String>> rows = ExcelUtils.readSheetAsRows(file, "Sheet1");

        assertEquals(2, rows.size());
        assertEquals(List.of("col1", "col2"), rows.get(0));
        assertEquals(List.of("x", "y"), rows.get(1));
    }
}
