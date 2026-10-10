import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test, expect } from '@playwright/test';
import { ConfigReader, loadEnv } from '../src/config/env';

/** A reader over explicit values, with no dependence on the repo's .env files or the runner's environment. */
const reader = (values: Record<string, string>) => new ConfigReader(values);

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
    expect(() => env.get('DOES_NOT_EXIST')).toThrow(/DOES_NOT_EXIST/);
  });

  test('getInt/getBoolean/getList fall back to defaults when the key is absent', () => {
    const env = loadEnv({ env: 'qa' });
    expect(env.getInt('RETRY_COUNT', 3)).toBe(3);
    expect(env.getBoolean('MISSING_FLAG', false)).toBe(false);
    expect(env.getList('MISSING_LIST')).toEqual([]);
  });
});

test.describe('ConfigReader parsing', () => {
  test('getBoolean accepts true/false, 1/0, yes/no, on/off in any case and surrounding spaces', () => {
    for (const yes of ['true', 'TRUE', '1', 'Yes', ' on ']) expect(reader({ F: yes }).getBoolean('F')).toBe(true);
    for (const no of ['false', 'False', '0', 'NO', 'off']) expect(reader({ F: no }).getBoolean('F', true)).toBe(false);
  });

  test('getBoolean throws on anything else, so HEADLESS=ture or HEADLESS=2 is not silently "false"', () => {
    for (const bad of ['ture', '2', '', 'enabled']) expect(() => reader({ HEADLESS: bad }).getBoolean('HEADLESS')).toThrow(/HEADLESS.*not a valid boolean/);
  });

  test('getInt parses whole integers and throws on trailing junk, decimals or empty strings', () => {
    expect(reader({ N: '42' }).getInt('N')).toBe(42);
    expect(reader({ N: ' -7 ' }).getInt('N')).toBe(-7);
    for (const bad of ['12abc', '1.5', '', 'abc', '0x10']) expect(() => reader({ N: bad }).getInt('N')).toThrow(/not a valid integer/);
  });

  test('getList trims and drops empty entries', () => {
    expect(reader({ L: ' a, b ,,c,' }).getList('L')).toEqual(['a', 'b', 'c']);
    expect(reader({ L: ' , ' }).getList('L')).toEqual([]);
    expect(reader({ L: '' }).getList('L', ['d'])).toEqual(['d']);
  });
});

test.describe('ConfigReader.toObject', () => {
  const withEnv = (vars: Record<string, string>, body: () => void) => {
    const saved: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(vars)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
    try {
      body();
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  };

  test('returns only the keys from the loaded .env files, never the rest of process.env', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-'));
    fs.writeFileSync(path.join(dir, '.env.qa'), 'FROM_FILE=1\nSHARED=file\n');
    withEnv({ CI_JOB_TOKEN: 'ci-secret-value', SHARED: 'from-process' }, () => {
      const env = loadEnv({ env: 'qa', dir });
      const all = env.toObject();
      expect(Object.keys(all).sort()).toEqual(['ENV', 'FROM_FILE', 'SHARED']);
      expect(JSON.stringify(all)).not.toContain('ci-secret-value');
      expect(all.SHARED).toBe('from-process'); // a real environment variable still wins, as get() does
      expect(env.get('CI_JOB_TOKEN')).toBe('ci-secret-value'); // ...and is still readable by name
    });
  });

  test('explicit values are returned; they are the declared configuration', () => {
    expect(reader({ A: '1', B: '2' }).toObject()).toEqual({ A: '1', B: '2' });
  });
});
