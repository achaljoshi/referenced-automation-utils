import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

/**
 * A correlation ID ties together everything one test does across systems -
 * the API calls it makes, the file it drops on SFTP, the SAP transaction it
 * runs - so a single failing flow can be traced end to end by grepping one
 * value in the console/CI log, the API gateway logs, and the target system.
 *
 * Two layers, because two kinds of caller exist:
 *
 * - `withCorrelationId` runs its action inside an AsyncLocalStorage scope, so
 *   overlapping calls (Promise.all, a background poller) each see their own
 *   ID and cannot corrupt each other's restore.
 * - `setCorrelationId` / `useTestCorrelation` set a process-wide value, which
 *   is what a Playwright fixture needs: the test body does not run inside the
 *   fixture's async chain, so a scope could not reach it. That is safe because
 *   a worker runs one test at a time. Inside a `withCorrelationId` scope the
 *   scope's own value is the one read (and set).
 *
 * The api/ui `test` fixtures set it automatically per test; use
 * `withCorrelationId` for code that runs outside a fixture.
 */
// Kept on globalThis under a registered symbol so two installed copies of this package (a version skew in
// node_modules) share one correlation state instead of each seeing its own.
interface CorrelationState {
  scope: AsyncLocalStorage<{ id: string | undefined }>;
  current: string | undefined;
}
const STATE_KEY = Symbol.for('@automation/referenced-automation-utils/correlation');
const globals = globalThis as unknown as Record<symbol, CorrelationState | undefined>;
const state: CorrelationState = (globals[STATE_KEY] ??= {
  scope: new AsyncLocalStorage(),
  current: undefined,
});

export function newCorrelationId(): string {
  return randomUUID();
}

export function getCorrelationId(): string | undefined {
  const scoped = state.scope.getStore();
  return scoped ? scoped.id : state.current;
}

export function setCorrelationId(id: string | undefined): void {
  const scoped = state.scope.getStore();
  if (scoped) scoped.id = id;
  else state.current = id;
}

/** Runs `action` with `id` as the active correlation ID, restoring whatever was active before afterwards. */
export async function withCorrelationId<T>(id: string, action: () => Promise<T> | T): Promise<T> {
  return state.scope.run({ id }, async () => action());
}

/**
 * For use inside an auto fixture (api/ui `test` already wire this up):
 *
 *   correlationId: [async ({}, use, testInfo) => useTestCorrelation(testInfo, use), { auto: true }],
 *
 * Gives every test its own correlation ID for the duration of that test,
 * attaches it to the test report as an annotation (so it can be searched
 * for in downstream systems' logs after a failure), and clears it afterwards
 * (or restores what was active before), so it can never leak into the next test run by the same worker.
 */
export async function useTestCorrelation(
  testInfo: { annotations: Array<{ type: string; description?: string }> },
  use: (id: string) => Promise<void>,
): Promise<void> {
  const previous = getCorrelationId();
  const id = newCorrelationId();
  setCorrelationId(id);
  testInfo.annotations.push({ type: 'correlationId', description: id });
  try {
    await use(id);
  } finally {
    setCorrelationId(previous);
  }
}
