import { test, expect } from '@playwright/test';
import { loadEnv } from '../src/config/env';

test.describe('loadEnv', () => {
  test('loads the qa env file by name', () => {
    const env = loadEnv({ env: 'qa' });
    expect(env.envName).toBe('qa');
    expect(env.get('SAMPLE_GREETING')).toBe('Hello from QA');
  });

  test('loads a different env file when asked', () => {
    const env = loadEnv({ env: 'stage' });
    expect(env.get('SAMPLE_GREETING')).toBe('Hello from Stage');
    expect(env.get('LOG_LEVEL')).toBe('debug');
  });

  test('falls back to a provided default for a missing key', () => {
    const env = loadEnv({ env: 'qa' });
    expect(env.get('DOES_NOT_EXIST', 'fallback')).toBe('fallback');
  });

  test('throws for a missing key with no default', () => {
    const env = loadEnv({ env: 'qa' });
    expect(() => env.get('DOES_NOT_EXIST')).toThrow();
  });

  test('getInt/getBoolean/getList parse correctly', () => {
    const env = loadEnv({ env: 'qa' });
    expect(env.getInt('RETRY_COUNT', 3)).toBe(3);
    expect(env.getBoolean('MISSING_FLAG', false)).toBe(false);
    expect(env.getList('MISSING_LIST')).toEqual([]);
  });
});
