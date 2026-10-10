import { test, expect } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import * as randomUtils from '../src/random/randomUtils';

test.describe('randomUtils', () => {
  test('generates plausible identity data', () => {
    expect(randomUtils.firstName().length).toBeGreaterThan(0);
    expect(randomUtils.lastName().length).toBeGreaterThan(0);
    expect(randomUtils.fullName()).toContain(' ');
    expect(randomUtils.email()).toMatch(/^[^\s@]+@[^\s@]+\.[^\s@]+$/);
  });

  test('email() only uses domains reserved for examples (RFC 2606), never a real mail provider', () => {
    for (let i = 0; i < 200; i++) expect(randomUtils.email()).toMatch(/@example\.(com|org|net)$/);
    expect(randomUtils.email('ada')).toMatch(/^ada[._]?.*@example\.(com|org|net)$/);
  });

  test('seed() makes the generators reproducible and returns the seed it used', () => {
    randomUtils.seed(1234);
    const first = [randomUtils.uuid(), randomUtils.email(), randomUtils.fullName(), randomUtils.number(0, 1e9)];
    randomUtils.seed(1234);
    const second = [randomUtils.uuid(), randomUtils.email(), randomUtils.fullName(), randomUtils.number(0, 1e9)];
    expect(second).toEqual(first);
    randomUtils.seed(1235);
    expect(randomUtils.uuid()).not.toBe(first[0]);
    expect(typeof randomUtils.seed()).toBe('number');
    expect(() => randomUtils.seed(1.5)).toThrow(/integer/);
  });

  test('RANDOM_SEED in the environment seeds a fresh process, so a run can be replayed', () => {
    const dist = path.resolve(__dirname, '../dist/random/randomUtils.js');
    const run = () =>
      spawnSync(process.execPath, ['-e', `process.stdout.write(require(${JSON.stringify(dist)}).uuid())`], {
        encoding: 'utf8',
        env: { ...process.env, RANDOM_SEED: '99', LOG_TO_FILE: 'false' },
      });
    const a = run();
    const b = run();
    expect(a.status).toBe(0);
    expect(a.stdout).toMatch(/[0-9a-f-]{36}$/);
    expect(a.stdout.slice(-36)).toBe(b.stdout.slice(-36));
    expect(a.stdout).toContain('random data seeded with 99');
  });

  test('number respects bounds', () => {
    for (let i = 0; i < 20; i++) {
      const n = randomUtils.number(5, 10);
      expect(n).toBeGreaterThanOrEqual(5);
      expect(n).toBeLessThanOrEqual(10);
    }
  });

  test('alphaNumeric/numericString respect length', () => {
    expect(randomUtils.alphaNumeric(12)).toHaveLength(12);
    expect(randomUtils.numericString(6)).toMatch(/^\d{6}$/);
  });

  test('uuid looks like a uuid', () => {
    expect(randomUtils.uuid()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  test('futureDate/pastDate return dates on the expected side of now', () => {
    const future = randomUtils.futureDate(5);
    const past = randomUtils.pastDate(5);
    expect(future.valueOf()).toBeGreaterThanOrEqual(Date.now() - 1000);
    expect(past.valueOf()).toBeLessThanOrEqual(Date.now() + 1000);
  });
});
