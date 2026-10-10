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

  test('compiling the same schema (with an $id) twice does not throw, and a different schema under one $id replaces it', () => {
    const schema = { $id: 'https://example.test/user.json', type: 'object', required: ['id'] };
    expect(validateSchema({ id: 1 }, schema).valid).toBe(true);
    expect(validateSchema({}, { ...schema }).valid).toBe(false); // an equal copy, not the same object
    expect(validateSchema({ id: 1 }, schema).valid).toBe(true);
    const changed = { $id: 'https://example.test/user.json', type: 'object', required: ['name'] };
    expect(validateSchema({ id: 1 }, changed).valid).toBe(false);
    expect(validateSchema({ name: 'Ada' }, changed).valid).toBe(true);
  });

  test('a misspelt keyword fails loudly instead of letting every payload through', () => {
    const typo = { type: 'object', requried: ['id'], properties: { id: { type: 'integer' } } };
    expect(() => validateSchema({}, typo)).toThrow(/unknown keyword.*requried/);
    expect(() => validateSchema('x', { type: 'string', minLenght: 3 })).toThrow(/unknown keyword.*minLenght/);
    expect(() => validateSchema('x', { type: 'string', format: 'emial' })).toThrow(/unknown format.*emial/);
  });

  test('strict: false accepts a schema you do not own, ignoring what it does not know', () => {
    const vendor = { type: 'object', 'x-vendor-note': 'hi', required: ['id'] };
    expect(() => validateSchema({ id: 1 }, vendor)).toThrow(/unknown keyword/);
    expect(validateSchema({ id: 1 }, vendor, { strict: false }).valid).toBe(true);
    expect(validateSchema({}, vendor, { strict: false }).valid).toBe(false);
  });

  test('OpenAPI annotation keywords (example, nullable) do not trip strict mode', () => {
    const schema = { type: 'object', properties: { nick: { type: 'string', nullable: true, example: 'ada' } } };
    expect(validateSchema({ nick: null }, schema).valid).toBe(true);
    expect(validateSchema({ nick: 5 }, schema).valid).toBe(false);
  });

  test('a schema that is not valid JSON Schema throws; validating with an array or boolean schema works', () => {
    expect(() => validateSchema({}, { type: 'strng' })).toThrow();
    expect(validateSchema([1, 2], { type: 'array', items: { type: 'integer' }, minItems: 2 }).valid).toBe(true);
    expect(validateSchema([1, 'x'], { type: 'array', items: { type: 'integer' } }).errorsText).toContain('/1 must be integer');
    expect(validateSchema(1, true).valid).toBe(true);
    expect(validateSchema(1, false).valid).toBe(false);
  });

  test('allErrors: every problem is reported, not just the first', () => {
    const result = validateSchema({ id: 'x' }, userSchema);
    expect(result.errors.length).toBeGreaterThanOrEqual(3);
    expect(result.errorsText).toContain('/id must be integer');
    expect(result.errorsText).toContain("must have required property 'name'");
  });
});
