import { test, expect } from '@playwright/test';
import { getPath, hasPath, requirePath, setPath } from '../src/validation/objectPath';

const sample = {
  data: {
    users: [
      { id: 1, name: 'Ada', roles: ['admin', 'user'] },
      { id: 2, name: 'Grace', roles: ['user'] },
    ],
  },
};

test.describe('objectPath', () => {
  test('reads nested dot/bracket paths', () => {
    expect(getPath(sample, 'data.users[0].name')).toBe('Ada');
    expect(getPath(sample, 'data.users[1].roles[0]')).toBe('user');
  });

  test('returns the default for a missing path', () => {
    expect(getPath(sample, 'data.users[5].name', 'nobody')).toBe('nobody');
  });

  test('hasPath / requirePath', () => {
    expect(hasPath(sample, 'data.users[0].id')).toBe(true);
    expect(hasPath(sample, 'data.users[9].id')).toBe(false);
    expect(requirePath(sample, 'data.users[0].name')).toBe('Ada');
    expect(() => requirePath(sample, 'data.users[9].name')).toThrow();
  });

  test('setPath writes a nested value', () => {
    const target = { a: { b: [{ c: 1 }] } };
    setPath(target, 'a.b[0].c', 42);
    expect(target.a.b[0]?.c).toBe(42);
  });
});
