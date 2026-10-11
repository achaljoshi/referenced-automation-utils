import type { Adapter } from '../adapters/adapter';
import type { DbClient } from '../db/dbClient';
import type { ConfigReader } from '../config/env';
import { getRemoteHost, type DbCallOptions, type RemoteHost } from './remoteHost';

/**
 * A `DbClient` whose SQL runs on the remote desktop host, which can reach the database when this machine can not.
 * Provider and connection string come from REMOTE_DB_PROVIDER / REMOTE_DB_CONNECTION_STRING unless given. Tests that
 * depend on `DbClient` do not change: swap `SqliteClient` / a local client for this one when the remote host is on.
 * Parameters are positional (`@p0, @p1` for SqlClient, `?` for ODBC). `close()` does not close the shared host.
 */
export class RemoteDbClient implements DbClient, Adapter {
  readonly name = 'remote-db';

  constructor(
    private readonly host: RemoteHost,
    private readonly options: DbCallOptions = {},
  ) {}

  /** A client over the process-wide remote host, or `undefined` when REMOTE_ENABLED is not true (use a local client). */
  static async fromEnv(env?: ConfigReader, options?: DbCallOptions): Promise<RemoteDbClient | undefined> {
    const host = await getRemoteHost(env);
    return host ? new RemoteDbClient(host, options) : undefined;
  }

  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    const result = await this.host.dbQuery(sql, params, this.options);
    return result.rows as T[];
  }

  async queryScalar<T = unknown>(sql: string, params: unknown[] = []): Promise<T> {
    const [row] = await this.query<Record<string, unknown>>(sql, params);
    if (!row) throw new Error(`queryScalar found no rows for: ${sql}`);
    return Object.values(row)[0] as T;
  }

  async update(sql: string, params: unknown[] = []): Promise<number> {
    return (await this.host.dbUpdate(sql, params, this.options)).rowCount;
  }

  async healthCheck(): Promise<boolean> {
    return this.host.healthCheck();
  }

  async close(): Promise<void> {
    // The host is shared by the whole worker process; closeRemoteHost() ends it.
  }
}
