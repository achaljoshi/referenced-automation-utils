import { test, expect } from '@playwright/test';
import { loggedStep } from '../src/logger/logger';

test.describe('loggedStep', () => {
  test('returns the wrapped action result on success', async () => {
    const result = await loggedStep('do a thing', () => 42);
    expect(result).toBe(42);
  });

  test('propagates the error on failure', async () => {
    await expect(
      loggedStep('fail on purpose', () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
  });

  test('supports async actions', async () => {
    const result = await loggedStep('async thing', async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return 'done';
    });
    expect(result).toBe('done');
  });
});
