import { test, expect } from '@playwright/test';
import { AdapterError } from '../src/adapters/adapter';
import { SqliteClient } from '../src/db/sqliteClient';

/** Runs `action` against a fresh in-memory database and always closes it. */
async function withDb(action: (db: SqliteClient) => Promise<void>): Promise<void> {
  const db = new SqliteClient(':memory:');
  try {
    await action(db);
  } finally {
    await db.close().catch(() => undefined);
  }
}

test.describe('SqliteClient (DbClient contract)', () => {
  test('query/queryScalar/update work against a real (in-memory) database', async () => {
    await withDb(async (db) => {
      await db.update('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');
      await db.update('INSERT INTO users (id, name) VALUES (?, ?)', [1, 'Ada']);
      await db.update('INSERT INTO users (id, name) VALUES (?, ?)', [2, 'Grace']);

      const rows = await db.query<{ id: number; name: string }>('SELECT * FROM users ORDER BY id');
      expect(rows).toEqual([
        { id: 1, name: 'Ada' },
        { id: 2, name: 'Grace' },
      ]);

      const count = await db.queryScalar<number>('SELECT COUNT(*) FROM users');
      expect(count).toBe(2);

      const updated = await db.update('UPDATE users SET name = ? WHERE id = ?', ['Ada Lovelace', 1]);
      expect(updated).toBe(1);
    });
  });

  test('queryScalar with no matching row fails and says which query; query returns an empty list', async () => {
    await withDb(async (db) => {
      await db.update('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');
      await expect(db.queryScalar('SELECT name FROM users WHERE id = ?', [99])).rejects.toThrow(
        /queryScalar found no rows for: SELECT name FROM users WHERE id = \?/,
      );
      expect(await db.query('SELECT * FROM users WHERE id = ?', [99])).toEqual([]);
    });
  });

  test('queryScalar returns a NULL value as null (a row exists), unlike "no rows"', async () => {
    await withDb(async (db) => {
      await db.update('CREATE TABLE t (v TEXT)');
      await db.update('INSERT INTO t (v) VALUES (NULL)');
      expect(await db.queryScalar('SELECT v FROM t')).toBeNull();
    });
  });

  test('bad SQL surfaces as an AdapterError naming the adapter, with the database error as the cause', async () => {
    await withDb(async (db) => {
      const runs = [() => db.query('SELEC 1'), () => db.queryScalar('SELECT * FROM missing_table'), () => db.update('INSERT INTO nowhere VALUES (1)')];
      for (const run of runs) {
        const error = (await run().then(
          () => undefined,
          (e: unknown) => e,
        )) as AdapterError;
        expect(error).toBeInstanceOf(AdapterError);
        expect(error.adapter).toBe('sqlite');
        expect((error.cause as Error).message).toMatch(/syntax error|no such table/);
      }
      expect(await db.healthCheck()).toBe(true); // a failed statement does not break the connection
    });
  });

  test('parameters are bound, not concatenated: a quote in a value is data, not SQL', async () => {
    await withDb(async (db) => {
      await db.update('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');
      await db.update('INSERT INTO users (name) VALUES (?)', ["O'Brien"]);
      await db.update('INSERT INTO users (name) VALUES (?)', ['Ada']);
      expect(await db.query('SELECT name FROM users WHERE name = ?', ["x' OR '1'='1"])).toEqual([]);
      expect(await db.query('SELECT name FROM users WHERE name = ?', ["O'Brien"])).toEqual([{ name: "O'Brien" }]);
    });
  });

  test('healthCheck is false once the connection is closed', async () => {
    const db = new SqliteClient(':memory:');
    expect(await db.healthCheck()).toBe(true);
    await db.close();
    expect(await db.healthCheck()).toBe(false);
  });
});
