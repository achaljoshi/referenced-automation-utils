package com.company.automation.commons.csv;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;

class CsvUtilsTest {

    @TempDir
    Path tempDir;

    @Test
    void writesAndReadsBackAsMaps() {
        String file = tempDir.resolve("users.csv").toString();
        List<String> columns = List.of("id", "name");
        List<Map<String, Object>> records = List.of(
                Map.of("id", 1, "name", "Ada"),
                Map.of("id", 2, "name", "Grace")
        );

        CsvUtils.writeMaps(file, columns, records);
        List<Map<String, String>> readBack = CsvUtils.readAsMaps(file);

        assertEquals(2, readBack.size());
        assertEquals("Ada", readBack.get(0).get("name"));
        assertEquals("2", readBack.get(1).get("id"));
    }

    @Test
    void writesAndReadsBackRawRows() {
        String file = tempDir.resolve("raw.csv").toString();
        List<List<String>> rows = List.of(
                List.of("a", "b", "c"),
                List.of("1", "2", "3")
        );

        CsvUtils.writeRows(file, rows);
        List<List<String>> readBack = CsvUtils.readAsRows(file);

        assertEquals(rows, readBack);
    }
}
