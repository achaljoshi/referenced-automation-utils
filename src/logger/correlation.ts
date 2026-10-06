import { randomUUID } from 'node:crypto';

/**
 * A correlation ID ties together everything one test does across systems -
 * the API calls it makes, the file it drops on SFTP, the SAP transaction it
 * runs - so a single failing flow can be traced end to end by grepping one
 * value in the console/CI log, the API gateway logs, and the target system.
 *
 * Playwright runs each worker as its own process and a worker runs one test
 * at a time, so a plain module-level value is safe here: there is no other
 * test in the same process whose ID it could be confused with. The api/ui
 * `test` fixtures set it automatically per test; use `withCorrelationId` for
 * code that runs outside a fixture.
 */
let current: string | undefined;

export function newCorrelationId(): string {
  return randomUUID();
}

export function getCorrelationId(): string | undefined {
  return current;
}

export function setCorrelationId(id: string | undefined): void {
  current = id;
}

/** Runs `action` with `id` as the active correlation ID, restoring whatever was active before afterwards. */
export async function withCorrelationId<T>(id: string, action: () => Promise<T> | T): Promise<T> {
  const previous = current;
  current = id;
  try {
    return await action();
  } finally {
    current = previous;
  }
}

/**
 * For use inside an auto fixture (api/ui `test` already wire this up):
 *
 *   correlationId: [async ({}, use, testInfo) => useTestCorrelation(testInfo, use), { auto: true }],
 *
 * Gives every test its own correlation ID for the duration of that test,
 * attaches it to the test report as an annotation (so it can be searched
 * for in downstream systems' logs after a failure), and clears it afterwards
 * so it can never leak into the next test run by the same worker.
 */
export async function useTestCorrelation(
  testInfo: { annotations: Array<{ type: string; description?: string }> },
  use: (id: string) => Promise<void>,
): Promise<void> {
  const id = newCorrelationId();
  setCorrelationId(id);
  testInfo.annotations.push({ type: 'correlationId', description: id });
  try {
    await use(id);
  } finally {
    setCorrelationId(undefined);
  }
}
