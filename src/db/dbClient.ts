/**
 * Minimal, driver-agnostic contract every DB helper in this framework talks
 * to. Implement this once per real engine your project needs (Postgres via
 * `pg`, MySQL via `mysql2`, SQL Server via `mssql`, ...) - tests and page/API
 * helpers depend on this interface, never on a specific driver, so swapping
 * the underlying DB doesn't touch a single test.
 */
export interface DbClient {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  queryScalar<T = unknown>(sql: string, params?: unknown[]): Promise<T>;
  /** INSERT/UPDATE/DELETE/DDL. Returns affected row count where the driver reports one. */
  update(sql: string, params?: unknown[]): Promise<number>;
  close(): Promise<void>;
}
