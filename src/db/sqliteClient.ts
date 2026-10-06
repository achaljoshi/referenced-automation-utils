import { adapterStep, type Adapter } from '../adapters/adapter';
import type { DbClient } from './dbClient';

/**
 * Reference DbClient implementation backed by better-sqlite3 - used by this
 * package's own tests to prove the DbClient contract end-to-end without
 * needing a real database server, and usable as-is for teams whose test
 * fixtures/seed data live in a local SQLite file.
 */
export class SqliteClient implements DbClient, Adapter {
  readonly name = 'sqlite';
  private readonly db: import('better-sqlite3').Database;

  constructor(filenameOrMemory: string = ':memory:') {
    // Lazily required so `better-sqlite3` (a native module) is only loaded
    // by code paths that actually use SQLite - it's an optionalDependency.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require('better-sqlite3');
    this.db = new Database(filenameOrMemory);
  }

  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    return adapterStep(this.name, 'query', () => this.db.prepare(sql).all(...params) as T[], {
      level: 'debug',
      details: { sql, paramCount: params.length },
    });
  }

  async queryScalar<T = unknown>(sql: string, params: unknown[] = []): Promise<T> {
    return adapterStep(
      this.name,
      'queryScalar',
      () => {
        const row = this.db.prepare(sql).get(...params) as Record<string, unknown> | undefined;
        if (!row) throw new Error(`queryScalar found no rows for: ${sql}`);
        return Object.values(row)[0] as T;
      },
      { level: 'debug', details: { sql, paramCount: params.length } },
    );
  }

  async update(sql: string, params: unknown[] = []): Promise<number> {
    return adapterStep(this.name, 'update', () => this.db.prepare(sql).run(...params).changes, {
      details: { sql, paramCount: params.length },
    });
  }

  async healthCheck(): Promise<boolean> {
    try {
      this.db.prepare('SELECT 1').get();
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
