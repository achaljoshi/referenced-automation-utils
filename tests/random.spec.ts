import { test, expect } from '@playwright/test';
import * as randomUtils from '../src/random/randomUtils';

test.describe('randomUtils', () => {
  test('generates plausible identity data', () => {
    expect(randomUtils.firstName().length).toBeGreaterThan(0);
    expect(randomUtils.lastName().length).toBeGreaterThan(0);
    expect(randomUtils.fullName()).toContain(' ');
    expect(randomUtils.email()).toMatch(/^[^\s@]+@[^\s@]+\.[^\s@]+$/);
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
