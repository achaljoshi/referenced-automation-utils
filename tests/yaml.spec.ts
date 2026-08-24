import { test, expect } from '@playwright/test';
import * as yamlUtils from '../src/data/yamlUtils';

test.describe('yamlUtils', () => {
  test('toYaml/fromYaml round-trip', () => {
    const value = { name: 'Ada', roles: ['admin', 'user'] };
    expect(yamlUtils.fromYaml(yamlUtils.toYaml(value))).toEqual(value);
  });
});
