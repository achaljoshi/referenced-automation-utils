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

/**
 * These run the built logger in a child process, so they assert what a
 * person (or a CI job log) actually sees on the console, not what the code
 * intended to print.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

function runLogger(script: string, env: Record<string, string> = {}): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: path.join(__dirname, '..'),
    env: { PATH: process.env.PATH ?? '', LOG_TO_FILE: 'false', ...env },
    encoding: 'utf-8',
  });
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

const LOGGER = `require('./dist/logger/logger')`;

test.describe('logger console output', () => {
  test('is plain text with no ANSI colour codes in CI, with a level tag and timestamp', () => {
    const { stdout } = runLogger(`${LOGGER}.logger.info('hello world')`, { CI: '1' });
    expect(stdout).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} \[info\] hello world\n$/);
    expect(stdout).not.toContain('\u001b[');
  });

  test('colours the level when colour is forced on, and still redacts (the colour path used to crash on rebuilt log objects)', () => {
    const { stdout, status } = runLogger(`${LOGGER}.logger.info('coloured', { password: 'hunter2' })`, { FORCE_COLOR: '1' });
    expect(status).toBe(0);
    expect(stdout).toContain('\u001b[');
    expect(stdout).toContain('coloured');
    expect(stdout).not.toContain('hunter2');
  });

  test('strips ANSI colour codes from messages and error text, and prints a multi-line error as readable indented lines', () => {
    const { stdout } = runLogger(
      `${LOGGER}.logger.error('<< STEP FAILED: check', { error: '\\u001b[2mexpect(\\u001b[22mlocator\\u001b[2m).toBeVisible()\\u001b[22m failed\\n\\nLocator: x\\nTimeout: 500ms' })`,
      { CI: '1' },
    );
    expect(stdout).not.toContain('\u001b[');
    expect(stdout).toContain('[error] << STEP FAILED: check');
    expect(stdout).toContain('\n      expect(locator).toBeVisible() failed');
    expect(stdout).toContain('\n      Locator: x');
    expect(stdout).not.toContain('\\n');
  });

  test('redacts values under sensitive-looking keys, at any depth, but keeps the rest', () => {
    const { stdout } = runLogger(
      `${LOGGER}.logger.info('login', { user: 'ada', password: 'hunter2', headers: { Authorization: 'Bearer abc', accept: 'json' }, list: [{ apiKey: 'k' }] })`,
      { CI: '1' },
    );
    expect(stdout).not.toContain('hunter2');
    expect(stdout).not.toContain('Bearer abc');
    expect(stdout).toContain('[REDACTED]');
    expect(stdout).toContain('"user":"ada"');
    expect(stdout).toContain('"accept":"json"');
  });

  test('tags the worker and the first 8 chars of the correlation ID so parallel output stays readable', () => {
    const { stdout } = runLogger(
      `const l = ${LOGGER}; require('./dist/logger/correlation').setCorrelationId('abcdef12-3456-7890-abcd-ef1234567890'); l.logger.info('x')`,
      { CI: '1', TEST_WORKER_INDEX: '3' },
    );
    expect(stdout).toContain('[w3]');
    expect(stdout).toContain('[cid:abcdef12]');
    expect(stdout).not.toContain('3456-7890');
  });

  test('getLogger tags lines with a component name', () => {
    const { stdout } = runLogger(`${LOGGER}.getLogger('sftp').info('uploaded')`, { CI: '1' });
    expect(stdout).toMatch(/\[info\] \[sftp\] uploaded/);
  });

  test('honours LOG_LEVEL', () => {
    const { stdout } = runLogger(`const l = ${LOGGER}.logger; l.debug('quiet'); l.warn('loud')`, { CI: '1', LOG_LEVEL: 'warn' });
    expect(stdout).not.toContain('quiet');
    expect(stdout).toContain('loud');
  });

  test('writes JSON lines to the log file, redacted, and creates the directory', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logger-test-'));
    const file = path.join(dir, 'nested', 'run.log');
    runLogger(`${LOGGER}.logger.info('to file', { token: 'secret-token' })`, { CI: '1', LOG_TO_FILE: 'true', LOG_FILE: file });
    // winston flushes on process exit; give the filesystem a moment in case of buffering
    const written = fs.readFileSync(file, 'utf-8');
    const entry = JSON.parse(written.trim().split('\n')[0] ?? '');
    expect(entry.message).toBe('to file');
    expect(entry.token).toBe('[REDACTED]');
    expect(written).not.toContain('secret-token');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('keeps logging to the console - and does not crash - when the log file cannot be created', () => {
    const { stdout, status } = runLogger(`${LOGGER}.logger.info('still works')`, {
      CI: '1',
      LOG_TO_FILE: 'true',
      LOG_FILE: '/dev/null/cannot/exist.log',
    });
    expect(status).toBe(0);
    expect(stdout).toContain('file logging disabled');
    expect(stdout).toContain('still works');
  });
});
