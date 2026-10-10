import { test, expect } from '@playwright/test';
import { isSensitiveKey, logFilePath, loggedStep, redact, scrubText } from '../src/logger/logger';

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

test.describe('redaction', () => {
  test('keys are matched as words: secrets are redacted, passed/bypass/passport are not', () => {
    for (const key of ['password', 'Password', 'userPassword', 'db_passwd', 'pass', 'secret', 'clientSecret', 'token', 'accessToken', 'access_token', 'refreshToken', 'authorization', 'Authorization', 'x-api-key', 'apiKey', 'API_KEY', 'apikey', 'cookie', 'Set-Cookie', 'credentials', 'jwt', 'idJwt', 'sessionId', 'session', 'bearer', 'privateKey', 'private_key', 'secretKey', 'passphrase'])
      expect(isSensitiveKey(key), key).toBe(true);
    for (const key of ['passed', 'bypass', 'passport', 'passing', 'compass', 'tokenizer', 'keyboard', 'key', 'user', 'name', 'status', 'accept', 'publicKey'])
      expect(isSensitiveKey(key), key).toBe(false);
  });

  test('redact({ passed: 5 }) keeps the number; real secrets go, at any depth', () => {
    expect(redact({ passed: 5, bypass: true, passport: 'AB123' })).toEqual({ passed: 5, bypass: true, passport: 'AB123' });
    expect(redact({ a: { b: { c: { d: { e: { f: { g: { h: { password: 'x', ok: 1 } } } } } } } } })).toEqual({
      a: { b: { c: { d: { e: { f: { g: { h: { password: '[REDACTED]', ok: 1 } } } } } } } },
    });
  });

  test('a cyclic object is cut, not recursed into forever; a shared (non-cyclic) object is kept', () => {
    const loop: Record<string, unknown> = { name: 'loop', token: 't' };
    loop.self = loop;
    expect(redact(loop)).toEqual({ name: 'loop', token: '[REDACTED]', self: '[Circular]' });
    const shared = { v: 1 };
    expect(redact({ a: shared, b: shared })).toEqual({ a: { v: 1 }, b: { v: 1 } });
  });

  test('an Error is logged with its message (scrubbed), a Date stays a Date', () => {
    const out = redact({ error: new Error('call to https://u:hunter2pw@host/x failed'), when: new Date('2026-01-01T00:00:00Z') }) as {
      error: { name: string; message: string };
      when: Date;
    };
    expect(out.error.name).toBe('Error');
    expect(out.error.message).toBe('call to https://u:[REDACTED]@host/x failed');
    expect(out.when).toBeInstanceOf(Date);
  });

  test('scrubText removes Bearer tokens, Authorization headers, JWTs, URL passwords and key=value secrets from free text', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    expect(scrubText('got Bearer abcdef0123456789 back')).toBe('got Bearer [REDACTED] back');
    expect(scrubText("curl -H 'Authorization: Bearer abcdef0123456789' https://x")).not.toContain('abcdef0123456789');
    expect(scrubText('Authorization: Basic dXNlcjpwYXNz')).toBe('Authorization: [REDACTED]');
    expect(scrubText(`token was ${jwt} ok`)).toBe('token was [REDACTED] ok');
    expect(scrubText('connect postgres://app:s3cretPw@db.internal:5432/x')).toBe('connect postgres://app:[REDACTED]@db.internal:5432/x');
    expect(scrubText('GET /cb?access_token=abc123&state=ok')).toBe('GET /cb?access_token=[REDACTED]&state=ok');
    expect(scrubText('PASSWORD="hunter2 hunter2" next')).toBe('PASSWORD=[REDACTED] next');
    expect(scrubText('{"user":"ada","password":"hunter2","n":1}')).toBe('{"user":"ada","password":"[REDACTED]","n":1}');
  });

  test('scrubText leaves ordinary text alone', () => {
    for (const text of ['Bearer of bad news', 'token expired for user ada', 'https://example.com/path?x=1', 'ssh://git@host/repo.git', 'user@example.com', '3 passed, 0 failed'])
      expect(scrubText(text)).toBe(text);
  });

  test('logFilePath adds the worker index only when asked to', () => {
    expect(logFilePath('logs/automation.log', false, '2')).toBe('logs/automation.log');
    expect(logFilePath('logs/automation.log', true, undefined)).toBe('logs/automation.log');
    expect(logFilePath('logs/automation.log', true, '2')).toBe('logs/automation-w2.log');
    expect(logFilePath('out/run', true, '0')).toBe('out/run-w0');
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

  test('scrubs credentials out of the message and the error text that reach the console and the file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logger-test-'));
    const file = path.join(dir, 'run.log');
    const { stdout } = runLogger(
      `const l = ${LOGGER}.logger; l.info('calling with Bearer abcdef0123456789 now'); l.error('failed', { error: 'GET https://u:pw-12345@host/x?api_key=k-98765 -> 401', passed: 3 })`,
      { CI: '1', LOG_TO_FILE: 'true', LOG_FILE: file },
    );
    const written = fs.readFileSync(file, 'utf-8');
    for (const text of [stdout, written]) {
      expect(text).not.toContain('abcdef0123456789');
      expect(text).not.toContain('pw-12345');
      expect(text).not.toContain('k-98765');
    }
    expect(stdout).toContain('"passed":3');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('LOG_FILE_PER_WORKER writes automation-w<N>.log, one file per worker', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logger-test-'));
    const file = path.join(dir, 'run.log');
    const env = { CI: '1', LOG_TO_FILE: 'true', LOG_FILE: file, LOG_FILE_PER_WORKER: 'true' };
    runLogger(`${LOGGER}.logger.info('from worker 1')`, { ...env, TEST_WORKER_INDEX: '1' });
    runLogger(`${LOGGER}.logger.info('from worker 2')`, { ...env, TEST_WORKER_INDEX: '2' });
    expect(fs.readdirSync(dir).sort()).toEqual(['run-w1.log', 'run-w2.log']);
    expect(fs.readFileSync(path.join(dir, 'run-w1.log'), 'utf-8')).toContain('from worker 1');
    expect(fs.readFileSync(path.join(dir, 'run-w1.log'), 'utf-8')).not.toContain('from worker 2');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
