import { test, expect } from '@playwright/test';
import * as jsonUtils from '../src/data/jsonUtils';

test.describe('jsonUtils', () => {
  test('toJson/fromJson round-trip', () => {
    const value = { a: 1, b: ['x', 'y'] };
    expect(jsonUtils.fromJson(jsonUtils.toJson(value))).toEqual(value);
  });

  test('toPrettyJson is indented', () => {
    expect(jsonUtils.toPrettyJson({ a: 1 })).toContain('\n');
  });

  test('readAt traverses a path on a JSON string', () => {
    const json = jsonUtils.toJson({ data: { users: [{ name: 'Ada' }] } });
    expect(jsonUtils.readAt(json, 'data.users[0].name')).toBe('Ada');
  });
});
