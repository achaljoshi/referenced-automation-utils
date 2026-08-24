package com.company.automation.commons.db;

import com.company.automation.commons.exceptions.CommonsException;
import org.apache.commons.dbutils.QueryRunner;
import org.apache.commons.dbutils.handlers.MapListHandler;
import org.apache.commons.dbutils.handlers.ScalarHandler;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.SQLException;
import java.util.List;
import java.util.Map;

/**
 * Thin, JDBC-driver-agnostic database helper built on Apache Commons DbUtils.
 * This library intentionally does NOT bundle a JDBC driver (Oracle/MySQL/
 * Postgres/MSSQL/H2, ...) - the consuming project adds whichever driver its
 * environment needs as its own Maven dependency, then passes a {@link Connection}
 * (or JDBC URL/credentials) into these helpers.
 *
 * <p>Typical usage in a step definition:
 * <pre>{@code
 * try (Connection conn = DatabaseUtils.getConnection(url, user, password)) {
 *     List<Map<String, Object>> rows = DatabaseUtils.query(conn, "SELECT * FROM orders WHERE id = ?", orderId);
 * }
 * }</pre>
 */
public final class DatabaseUtils {

    private static final QueryRunner RUNNER = new QueryRunner();

    private DatabaseUtils() {
    }

    public static Connection getConnection(String jdbcUrl, String username, String password) {
        try {
            return DriverManager.getConnection(jdbcUrl, username, password);
        } catch (SQLException e) {
            throw new CommonsException("Failed to open database connection: " + jdbcUrl, e);
        }
    }

    /** Runs a SELECT and returns every row as a {@code Map<column, value>}, preserving column order. */
    public static List<Map<String, Object>> query(Connection connection, String sql, Object... params) {
        try {
            return RUNNER.query(connection, sql, new MapListHandler(), params);
        } catch (SQLException e) {
            throw new CommonsException("Query failed: " + sql, e);
        }
    }

    /** Runs a SELECT expected to return exactly one scalar value, e.g. {@code SELECT COUNT(*) ...}. */
    public static Object queryScalar(Connection connection, String sql, Object... params) {
        try {
            return RUNNER.query(connection, sql, new ScalarHandler<>(), params);
        } catch (SQLException e) {
            throw new CommonsException("Scalar query failed: " + sql, e);
        }
    }

    /** Runs an INSERT/UPDATE/DELETE and returns the number of affected rows. */
    public static int update(Connection connection, String sql, Object... params) {
        try {
            return RUNNER.update(connection, sql, params);
        } catch (SQLException e) {
            throw new CommonsException("Update failed: " + sql, e);
        }
    }

    /** Closes a connection, swallowing any {@link SQLException} - safe to call from a cleanup/@After hook. */
    public static void closeQuietly(Connection connection) {
        if (connection == null) {
            return;
        }
        try {
            connection.close();
        } catch (SQLException ignored) {
            // Intentionally swallowed: this is a best-effort cleanup helper.
        }
    }
}
