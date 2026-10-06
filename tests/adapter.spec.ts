import { test, expect } from '@playwright/test';
import { AdapterError, adapterStep } from '../src/adapters/adapter';
import { getCorrelationId, newCorrelationId, setCorrelationId, withCorrelationId } from '../src/logger/correlation';

test.describe('adapterStep', () => {
  test('returns the action result', async () => {
    await expect(adapterStep('demo', 'op', () => 42)).resolves.toBe(42);
  });

  test('wraps a failure in an AdapterError naming the adapter and operation, preserving the cause', async () => {
    const cause = new Error('connection refused');
    const error = await adapterStep('sftp', 'upload', () => {
      throw cause;
    }).catch((e) => e);
    expect(error).toBeInstanceOf(AdapterError);
    expect(error.adapter).toBe('sftp');
    expect(error.operation).toBe('upload');
    expect(error.message).toBe('[sftp] upload failed: connection refused');
    expect(error.cause).toBe(cause);
  });

  test('passes an AdapterError from a nested adapter through unchanged instead of double-wrapping', async () => {
    const inner = new AdapterError('smtp', 'send', 'bad auth');
    const error = await adapterStep('outer', 'flow', () => {
      throw inner;
    }).catch((e) => e);
    expect(error).toBe(inner);
  });
});

test.describe('correlation id', () => {
  test.afterEach(() => setCorrelationId(undefined));

  test('is unset by default, settable, and generated ids are unique', () => {
    expect(getCorrelationId()).toBeUndefined();
    setCorrelationId('abc');
    expect(getCorrelationId()).toBe('abc');
    expect(newCorrelationId()).not.toBe(newCorrelationId());
  });

  test('withCorrelationId restores the previous value, even if the action throws', async () => {
    setCorrelationId('outer');
    await expect(
      withCorrelationId('inner', async () => {
        expect(getCorrelationId()).toBe('inner');
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(getCorrelationId()).toBe('outer');
  });
});

import { useTestCorrelation } from '../src/logger/correlation';

test.describe('useTestCorrelation', () => {
  test('sets an id for the duration of use(), annotates the test with it, and clears it afterwards', async () => {
    const annotations: Array<{ type: string; description?: string }> = [];
    let seenDuring: string | undefined;
    await useTestCorrelation({ annotations }, async (id) => {
      seenDuring = getCorrelationId();
      expect(id).toBe(seenDuring);
    });
    expect(seenDuring).toMatch(/^[0-9a-f-]{36}$/);
    expect(annotations).toEqual([{ type: 'correlationId', description: seenDuring }]);
    expect(getCorrelationId()).toBeUndefined();
  });
});
