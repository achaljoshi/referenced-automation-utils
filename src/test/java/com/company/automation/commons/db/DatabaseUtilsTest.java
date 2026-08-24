package com.company.automation.commons.db;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.sql.Connection;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * Exercises DatabaseUtils against a real (in-memory H2) database rather than
 * mocking java.sql.Connection - a mocked JDBC round trip would only prove the
 * mock behaves as configured, not that the SQL/parameter binding is correct.
 */
class DatabaseUtilsTest {

    private Connection connection;

    @BeforeEach
    void setUp() {
        connection = DatabaseUtils.getConnection("jdbc:h2:mem:utils-test;DB_CLOSE_DELAY=-1", "sa", "");
        DatabaseUtils.update(connection, "CREATE TABLE users (id INT PRIMARY KEY, name VARCHAR(100))");
        DatabaseUtils.update(connection, "INSERT INTO users (id, name) VALUES (?, ?)", 1, "Ada");
        DatabaseUtils.update(connection, "INSERT INTO users (id, name) VALUES (?, ?)", 2, "Grace");
    }

    @AfterEach
    void tearDown() {
        DatabaseUtils.closeQuietly(connection);
    }

    @Test
    void queryReturnsRowsAsMaps() {
        List<Map<String, Object>> rows = DatabaseUtils.query(connection, "SELECT * FROM users ORDER BY id");
        assertEquals(2, rows.size());
        assertEquals("Ada", rows.get(0).get("NAME"));
    }

    @Test
    void queryScalarReturnsSingleValue() {
        Object count = DatabaseUtils.queryScalar(connection, "SELECT COUNT(*) FROM users");
        assertEquals(2L, ((Number) count).longValue());
    }

    @Test
    void updateReturnsAffectedRowCount() {
        int updated = DatabaseUtils.update(connection, "UPDATE users SET name = ? WHERE id = ?", "Ada Lovelace", 1);
        assertEquals(1, updated);

        List<Map<String, Object>> rows = DatabaseUtils.query(connection, "SELECT name FROM users WHERE id = ?", 1);
        assertEquals("Ada Lovelace", rows.get(0).get("NAME"));
    }
}
