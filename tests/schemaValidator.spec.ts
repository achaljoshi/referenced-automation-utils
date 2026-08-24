import { test, expect } from '@playwright/test';
import { validateSchema } from '../src/validation/schemaValidator';

const userSchema = {
  type: 'object',
  required: ['id', 'name', 'email'],
  properties: {
    id: { type: 'integer' },
    name: { type: 'string' },
    email: { type: 'string', format: 'email' },
  },
} as const;

test.describe('validateSchema', () => {
  test('passes for a matching object', () => {
    const result = validateSchema({ id: 1, name: 'Ada', email: 'ada@example.com' }, userSchema);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test('fails with a readable message for a missing required field', () => {
    const result = validateSchema({ id: 1, name: 'Ada' }, userSchema);
    expect(result.valid).toBe(false);
    expect(result.errorsText).toContain('email');
  });

  test('fails for a wrong-typed field', () => {
    const result = validateSchema({ id: '1', name: 'Ada', email: 'ada@example.com' }, userSchema);
    expect(result.valid).toBe(false);
  });

  test('enforces string format (email)', () => {
    const result = validateSchema({ id: 1, name: 'Ada', email: 'not-an-email' }, userSchema);
    expect(result.valid).toBe(false);
  });
});
