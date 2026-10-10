import * as fs from 'node:fs';
import * as path from 'node:path';
import * as winston from 'winston';
import { getCorrelationId } from './correlation';

/**
 * Shared logger, built to read correctly both at a developer's terminal and
 * in a raw CI job log:
 *
 * - Console always, on stdout (never split across stdout/stderr, so line
 *   order is preserved). Colour only when attached to a real terminal and
 *   not in CI / NO_COLOR - ANSI escape codes in a GitLab job log are noise.
 * - Every line carries the Playwright worker (`[w2]`) and, when one is
 *   active, the first 8 characters of the correlation ID - with tests
 *   running in parallel, interleaved lines are unreadable without them.
 * - A JSON-lines file (default logs/automation.log) for machine reading and
 *   as a CI artifact. If the file can't be created (read-only checkout,
 *   locked-down runner) the logger keeps working on console alone rather
 *   than crashing the test run.
 * - Values under keys that look sensitive (password, token, authorization,
 *   secret, api key, cookie, credential, jwt, session, bearer, private) are
 *   redacted before anything is written, so a stray
 *   `logger.info('x', { headers })` can't leak them. Keys are matched as
 *   words (`passed`, `bypass`, `passport` are fine), at any depth. Free text
 *   is scrubbed too: `Bearer <token>`, JWTs, `scheme://user:pass@host` and
 *   `password=...` in a message or error text.
 *
 * Env knobs: LOG_LEVEL (default info), LOG_TO_FILE=false, LOG_FILE=<path>,
 * LOG_FILE_PER_WORKER=true (one file per Playwright worker, rotated, e.g.
 * automation-w2.log), NO_COLOR=1, FORCE_COLOR=1.
 */
/** logs/automation.log -> logs/automation-w2.log for worker 2, so parallel workers do not interleave lines in one shared file. */
export function logFilePath(file: string, perWorker: boolean, worker: string | undefined): string {
  if (!perWorker || worker === undefined) return file;
  const ext = path.extname(file);
  return `${file.slice(0, file.length - ext.length)}-w${worker}${ext}`;
}

const level = process.env.LOG_LEVEL ?? 'info';
const logToFile = (process.env.LOG_TO_FILE ?? 'true').toLowerCase() !== 'false';
const perWorkerFile = (process.env.LOG_FILE_PER_WORKER ?? 'false').toLowerCase() === 'true';
const logFile = logFilePath(process.env.LOG_FILE ?? 'logs/automation.log', perWorkerFile, process.env.TEST_WORKER_INDEX);
const useColor =
  (process.stdout.isTTY === true && !process.env.CI && !process.env.NO_COLOR) || Boolean(process.env.FORCE_COLOR);

const REDACTED = '[REDACTED]';

// Words (after splitting camelCase, snake_case, kebab-case and dotted keys) that mark a value as sensitive.
const SENSITIVE_WORDS = new Set([
  'pass',
  'password',
  'passwd',
  'pwd',
  'passphrase',
  'passcode',
  'secret',
  'secrets',
  'token',
  'tokens',
  'authorization',
  'cookie',
  'cookies',
  'credential',
  'credentials',
  'jwt',
  'session',
  'bearer',
  'private',
  'apikey',
]);
// compound forms that are only sensitive together ("key" alone is not: it is a lookup key, a primary key, ...)
const SENSITIVE_COMPACT = /apikey|accesskey|secretkey|privatekey|signingkey|sessionid|xapikey/;

/** True for a key that names a secret: matched as whole words, so `password`, `apiKey`, `x-api-key`, `Set-Cookie` yes; `passed`, `bypass`, `passport` no. */
export function isSensitiveKey(key: string): boolean {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  if (words.some((word) => SENSITIVE_WORDS.has(word))) return true;
  return SENSITIVE_COMPACT.test(words.join(''));
}

// Playwright (and other tools) embed ANSI colour codes in error text. In a
// CI job log or a log file they show up as literal escape junk, so strip them
// from everything we write; colour in our own output is added separately.
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
export function stripAnsi(value: string): string {
  return value.replace(ANSI, '');
}

const SENSITIVE_NAME = '[\\w.-]*(?:password|passwd|pwd|passphrase|secret|token|api[_-]?key|credential|cookie)[\\w.-]*';
const TEXT_PATTERNS: Array<[RegExp, string]> = [
  // Authorization: Bearer abc / Authorization: Basic abc / "authorization":"abc"
  [/(\bauthorization["']?\s*[:=]\s*["']?)(?:(?:bearer|basic|token|digest)\s+)?[^\s"',;]+/gi, `$1${REDACTED}`],
  // a bare "Bearer <token>" (curl -H 'Authorization: Bearer ...' is covered above; this catches prose and error text)
  [/\b(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, `$1${REDACTED}`],
  // a JSON Web Token
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, REDACTED],
  // scheme://user:password@host
  [/\b([a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:)[^/\s@]+@/gi, `$1${REDACTED}@`],
  // "password": "x" / 'token': 'x' inside JSON-ish text
  [new RegExp(`(["']${SENSITIVE_NAME}["']\\s*:\\s*)(?:"(?:[^"\\\\]|\\\\.)*"|'[^']*')`, 'gi'), `$1"${REDACTED}"`],
  // password=x, access_token=x, API_KEY="x" (query strings, env-style lines)
  [new RegExp(`(\\b${SENSITIVE_NAME}\\s*=\\s*)(?:"[^"]*"|'[^']*'|[^\\s&,;)"']+)`, 'gi'), `$1${REDACTED}`],
];

/** Removes credentials from free text: Bearer tokens, Authorization headers, JWTs, URL passwords, `password=...`, `"token": "..."`. */
export function scrubText(text: string): string {
  let out = text;
  for (const [pattern, replacement] of TEXT_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

function walk(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') return scrubText(stripAnsi(value));
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => walk(item, seen));
    if (value instanceof Error) {
      // Error fields are not enumerable, so the generic path below would log it as {}
      return {
        name: value.name,
        message: walk(value.message, seen),
        ...(value.stack ? { stack: walk(value.stack, seen) } : {}),
      };
    }
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      out[key] = isSensitiveKey(key) ? REDACTED : walk(inner, seen);
    }
    return out;
  } finally {
    // only a value that contains itself is "circular"; the same object appearing twice side by side is not
    seen.delete(value);
  }
}

/** A copy of `value` that is safe to write: sensitive keys redacted at any depth (cycles are cut, not recursed into), credentials scrubbed from strings, ANSI stripped. */
export function redact(value: unknown): unknown {
  return walk(value, new WeakSet());
}

function context(): string {
  const worker = process.env.TEST_WORKER_INDEX;
  const cid = getCorrelationId();
  return `${worker !== undefined ? ` [w${worker}]` : ''}${cid ? ` [cid:${cid.slice(0, 8)}]` : ''}`;
}

// Mutates in place on purpose: winston keeps its own bookkeeping (level,
// message, splat) under Symbol keys on the same object, and a rebuilt object
// would silently drop them and break later formatters such as colorize.
const redactFormat = winston.format((info) => {
  for (const key of Object.keys(info)) {
    if (key === 'message') {
      if (typeof info.message === 'string') info.message = scrubText(stripAnsi(info.message));
      continue;
    }
    if (key === 'level' || key === 'timestamp' || key === 'component') continue;
    (info as Record<string, unknown>)[key] = isSensitiveKey(key) ? REDACTED : redact((info as Record<string, unknown>)[key]);
  }
  return info;
});

const consoleFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
  redactFormat(),
  ...(useColor ? [winston.format.colorize({ level: true })] : []),
  winston.format.printf(({ timestamp, level: lvl, message, component, error, ...meta }) => {
    const extra = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
    const comp = component ? ` [${String(component)}]` : '';
    // A multi-line error (e.g. a failed Playwright assertion) is printed as
    // indented lines under the message, not as one long JSON-escaped string.
    const errorBlock =
      typeof error === 'string' && error.length > 0
        ? `\n${error
            .split('\n')
            .filter((line) => line.trim().length > 0)
            .map((line) => `      ${line}`)
            .join('\n')}`
        : '';
    return `${timestamp} [${lvl}]${context()}${comp} ${message}${extra}${errorBlock}`;
  }),
);

const fileFormat = winston.format.combine(
  winston.format.timestamp(),
  redactFormat(),
  winston.format.printf((info) =>
    JSON.stringify({ ...info, worker: process.env.TEST_WORKER_INDEX, correlationId: getCorrelationId() }),
  ),
);

function fileTransportIfWritable(): winston.transport[] {
  if (!logToFile) return [];
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.accessSync(path.dirname(logFile), fs.constants.W_OK);
    // A file of its own (per worker) can be rotated safely; one file shared by several processes cannot.
    const rotation = perWorkerFile ? { maxsize: 10 * 1024 * 1024, maxFiles: 3 } : {};
    return [new winston.transports.File({ filename: logFile, format: fileFormat, ...rotation })];
  } catch (error) {
    process.stdout.write(
      `[logger] file logging disabled - cannot write to "${logFile}": ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    return [];
  }
}

export const logger = winston.createLogger({
  level,
  transports: [new winston.transports.Console({ format: consoleFormat }), ...fileTransportIfWritable()],
});

/** A logger whose lines are tagged with a component name, e.g. `[sftp]`, `[sap-gui]` - one shared logger underneath, so output ordering and formatting stay identical. */
export function getLogger(component: string): winston.Logger {
  return logger.child({ component });
}

/**
 * Wraps a step (a UI action, an API call, a business step) with start/pass/fail
 * logging, so every step's outcome is visible without hand-adding log lines
 * everywhere - the equivalent of the Java framework's StepLoggerPlugin, but
 * usable directly around any function rather than tied to a Cucumber hook.
 */
export async function loggedStep<T>(name: string, action: () => Promise<T> | T): Promise<T> {
  const startedAt = Date.now();
  logger.info(`>> STEP: ${name}`);
  try {
    const result = await action();
    logger.info(`<< STEP PASSED (${Date.now() - startedAt}ms): ${name}`);
    return result;
  } catch (error) {
    logger.error(`<< STEP FAILED (${Date.now() - startedAt}ms): ${name}`, {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
