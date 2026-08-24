import { test, expect } from '@playwright/test';
import { SqliteClient } from '../src/db/sqliteClient';

test.describe('SqliteClient (DbClient contract)', () => {
  test('query/queryScalar/update work against a real (in-memory) database', async () => {
    const db = new SqliteClient(':memory:');
    try {
      await db.update('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');
      await db.update('INSERT INTO users (id, name) VALUES (?, ?)', [1, 'Ada']);
      await db.update('INSERT INTO users (id, name) VALUES (?, ?)', [2, 'Grace']);

      const rows = await db.query<{ id: number; name: string }>(
        'SELECT * FROM users ORDER BY id',
      );
      expect(rows).toEqual([
        { id: 1, name: 'Ada' },
        { id: 2, name: 'Grace' },
      ]);

      const count = await db.queryScalar<number>('SELECT COUNT(*) FROM users');
      expect(count).toBe(2);

      const updated = await db.update('UPDATE users SET name = ? WHERE id = ?', [
        'Ada Lovelace',
        1,
      ]);
      expect(updated).toBe(1);
    } finally {
      await db.close();
    }
  });
});
