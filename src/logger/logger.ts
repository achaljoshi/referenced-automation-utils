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
 *   secret, api key, cookie, credential) are redacted before anything is
 *   written, so a stray `logger.info('x', { headers })` can't leak them.
 *
 * Env knobs: LOG_LEVEL (default info), LOG_TO_FILE=false, LOG_FILE=<path>,
 * NO_COLOR=1, FORCE_COLOR=1.
 */
const level = process.env.LOG_LEVEL ?? 'info';
const logToFile = (process.env.LOG_TO_FILE ?? 'true').toLowerCase() !== 'false';
const logFile = process.env.LOG_FILE ?? 'logs/automation.log';
const useColor =
  (process.stdout.isTTY === true && !process.env.CI && !process.env.NO_COLOR) || Boolean(process.env.FORCE_COLOR);

const SENSITIVE_KEY = /pass(word|wd)?|secret|token|authorization|api[-_]?key|cookie|credential/i;
const REDACTED = '[REDACTED]';

// Playwright (and other tools) embed ANSI colour codes in error text. In a
// CI job log or a log file they show up as literal escape junk, so strip them
// from everything we write; colour in our own output is added separately.
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
export function stripAnsi(value: string): string {
  return value.replace(ANSI, '');
}

export function redact(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return stripAnsi(value);
  if (value === null || typeof value !== 'object' || depth > 6) return value;
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SENSITIVE_KEY.test(key) ? REDACTED : redact(inner, depth + 1);
  }
  return out;
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
      if (typeof info.message === 'string') info.message = stripAnsi(info.message);
      continue;
    }
    if (key === 'level' || key === 'timestamp' || key === 'component') continue;
    (info as Record<string, unknown>)[key] = SENSITIVE_KEY.test(key) ? REDACTED : redact((info as Record<string, unknown>)[key]);
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
    return [new winston.transports.File({ filename: logFile, format: fileFormat })];
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
